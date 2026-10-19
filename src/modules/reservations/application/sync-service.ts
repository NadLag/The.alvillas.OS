import {
  ReservationConflictError,
  ReservationNotFoundError,
  completeAssignedFieldTaskInTransaction,
  type ReservationAuditMeta
} from "@/modules/reservations/application/reservation-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import type {
  SyncPushInput,
  SyncPushOp,
  SyncPushOpResult,
  SyncPushResult
} from "@/modules/reservations/domain/sync-protocol";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import {
  SyncRepository,
  type SyncOpRecord
} from "@/modules/reservations/infrastructure/sync-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

type SyncServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

function db(deps: SyncServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function metaForOp(deps: SyncServiceDeps, op: SyncPushOp): ReservationAuditMeta {
  return {
    requestId: `${deps.requestId ?? crypto.randomUUID()}:${op.client_op_id}`,
    ipAddress: deps.ipAddress ?? null
  };
}

function resultFromExisting(op: SyncOpRecord): SyncPushOpResult {
  const serverVersion =
    typeof op.result?.server_version === "string" ? op.result.server_version : null;

  return {
    client_op_id: op.clientOpId,
    status: "DUPLICATE",
    server_version: serverVersion,
    error_code: op.errorCode ?? undefined
  };
}

function appliedResult(op: SyncPushOp, serverVersion: string | null): SyncPushOpResult {
  return {
    client_op_id: op.client_op_id,
    status: "APPLIED",
    server_version: serverVersion
  };
}

function conflictResult(op: SyncPushOp, message: string): SyncPushOpResult {
  return {
    client_op_id: op.client_op_id,
    status: "CONFLICT",
    server_version: null,
    conflict: {
      expected: op.base_version ?? null,
      current: message,
      incoming: "field_task.complete"
    },
    error_code: "TASK_COMPLETION_CONFLICT"
  };
}

function rejectedResult(op: SyncPushOp, errorCode: string): SyncPushOpResult {
  return {
    client_op_id: op.client_op_id,
    status: "REJECTED",
    server_version: null,
    error_code: errorCode
  };
}

export function parseSyncPushInput(input: unknown) {
  return syncPushInputSchema.safeParse(input);
}

export async function pushSyncOps(
  ctx: ReservationActorContext,
  input: SyncPushInput,
  deps: SyncServiceDeps = {}
): Promise<SyncPushResult> {
  const results: SyncPushOpResult[] = [];

  for (const op of input.ops) {
    const result = await withTenant(db(deps), ctx.organizationId, async (tx) => {
      const repository = new SyncRepository(tx, ctx.organizationId);
      const existing = await repository.findByClientOp(input.device_id, op.client_op_id);

      if (existing) {
        return resultFromExisting(existing);
      }

      await repository.createPending({
        deviceId: input.device_id,
        clientOpId: op.client_op_id,
        type: op.type,
        payload: op.payload,
        actorUserAccountId: ctx.actorId,
        actorPersonId: ctx.personId,
        clientCreatedAt: op.client_created_at ? new Date(op.client_created_at) : null
      });

      try {
        const completed = await completeAssignedFieldTaskInTransaction(
          ctx,
          {
            taskId: op.payload.taskId,
            idempotencyKey: op.client_op_id,
            checklistItemIds: op.payload.checklistItemIds,
            note: op.payload.note
          },
          tx,
          metaForOp(deps, op),
          "OFFLINE_SYNC"
        );
        const serverVersion = completed.completedAt?.toISOString() ?? null;
        const applied = appliedResult(op, serverVersion);
        await repository.finish(input.device_id, op.client_op_id, "APPLIED", applied, null);
        return applied;
      } catch (error) {
        if (error instanceof ReservationConflictError) {
          const conflict = conflictResult(op, error.message);
          await repository.finish(
            input.device_id,
            op.client_op_id,
            "CONFLICT",
            conflict,
            conflict.error_code ?? null
          );
          return conflict;
        }

        if (error instanceof ReservationNotFoundError) {
          const rejected = rejectedResult(op, "REJECTED_NOT_ASSIGNED");
          await repository.finish(
            input.device_id,
            op.client_op_id,
            "REJECTED",
            rejected,
            rejected.error_code ?? null
          );
          return rejected;
        }

        throw error;
      }
    });

    results.push(result);
  }

  return {
    op_schema_version: 1,
    results
  };
}
