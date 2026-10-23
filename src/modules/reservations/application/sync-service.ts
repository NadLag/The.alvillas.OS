import {
  ReservationConflictError,
  ReservationNotFoundError,
  ReservationAuthorizationError,
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
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
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
    status: op.status === "APPLIED" || op.status === "DUPLICATE" ? "DUPLICATE" : op.status === "CONFLICT" ? "CONFLICT" : "REJECTED",
    server_version: serverVersion,
    ...(op.result?.conflict ? { conflict: op.result.conflict as SyncPushOpResult["conflict"] } : {}),
    error_code: op.errorCode ?? undefined
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
  // A shared browser may have changed sessions while an offline tab remained open.
  if ((input.organization_id && input.organization_id !== ctx.organizationId) ||
      (input.actor_user_id && input.actor_user_id !== ctx.actorId)) {
    return { op_schema_version: 1, results: input.ops.map(op => rejectedResult(op, "REJECTED_SESSION_CHANGED")) };
  }
  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const results: SyncPushOpResult[] = [];
    const repository = new SyncRepository(tx, ctx.organizationId);
    // Hold the device lock for the entire batch, including durable acknowledgements.
    // A concurrent retry cannot observe a PENDING row or interleave this device's ops.
    await repository.lockDevice(input.device_id);
    const operations = new OperationRepository(tx, ctx.organizationId);
    for (const taskId of [...new Set(input.ops.map(op => op.payload.taskId))].sort()) await operations.lock(taskId);
    await repository.lockActor(ctx.personId);
    for (const op of input.ops) {
      const existing = await repository.findByClientOp(input.device_id, op.client_op_id);

      if (existing) {
        if (existing.actorUserAccountId !== ctx.actorId) {
          results.push(rejectedResult(op, "REJECTED_OP_OWNER"));
        } else if (existing.type !== op.type || canonical(existing.payload) !== canonical(op.payload)) {
          results.push(rejectedResult(op, "REJECTED_IDEMPOTENCY_KEY_REUSED"));
        } else {
          results.push(resultFromExisting(existing));
        }
        continue;
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
        const duplicateCompletion = completed.completionIdempotencyKey !== op.client_op_id;
        const applied: SyncPushOpResult = duplicateCompletion
          ? { ...appliedResult(op, serverVersion), status: "DUPLICATE", error_code: "DUPLICATE_COMPLETION" }
          : appliedResult(op, serverVersion);
        await repository.finish(input.device_id, op.client_op_id, applied.status, applied, applied.error_code ?? null);
        results.push(applied);
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
          results.push(conflict);
          continue;
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
          results.push(rejected);
          continue;
        }

        if (error instanceof ReservationAuthorizationError) {
          const rejected = rejectedResult(op, "REJECTED_FORBIDDEN");
          await repository.finish(input.device_id, op.client_op_id, "REJECTED", rejected, rejected.error_code!);
          results.push(rejected);
          continue;
        }

        throw error;
      }
    }
    return { op_schema_version: 1, results };
  });
}
