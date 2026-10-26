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
import { proxyCompleteOperationTaskInTransaction } from "./operation-service";
import {
  SyncRepository,
  type SyncOpRecord
} from "@/modules/reservations/infrastructure/sync-repository";
import { prisma } from "@/platform/db/client";
import { attachFieldUploadEvidenceInTransaction } from "./field-upload-service";
import { reportOperationIssueInTransaction } from "./operation-evidence";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { prepareFieldStocktakeBatch, recordFieldStocktakeInTransaction } from "@/platform/inventory/field-stocktake-service";
import { StocktakeConflictError, FieldStocktakeUnavailableError } from "@/platform/inventory/field-stocktake";
import { recordFieldCashInTransaction, confirmExistingFieldCashInTransaction } from "@/platform/ledger/field-cash-service";
import { FieldCashConflictError, FieldCashUnavailableError } from "@/platform/ledger/field-cash";

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
    ...(op.result?.stocktake ? { stocktake: op.result.stocktake as SyncPushOpResult["stocktake"] } : {}),
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
      expected: op.type === "field_task.proxy_validate" ? String(op.payload.expectedVersion) : op.base_version ?? null,
      current: message,
      incoming: op.type
    },
    error_code: op.type === "field_task.proxy_validate" ? "TASK_PROXY_VALIDATION_CONFLICT" :
      op.type === "field_task.complete" ? "TASK_COMPLETION_CONFLICT" : op.type === "field_task.issue.report" ? "TASK_ISSUE_CONFLICT" : "TASK_EVIDENCE_CONFLICT"
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
  if (input.organization_id !== ctx.organizationId || input.actor_user_id !== ctx.actorId) {
    return { op_schema_version: 1, results: input.ops.map(op => rejectedResult(op, "REJECTED_SESSION_CHANGED")) };
  }
  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const results: SyncPushOpResult[] = [];
    const repository = new SyncRepository(tx, ctx.organizationId);
    // Hold the device lock for the entire batch, including durable acknowledgements.
    // A concurrent retry cannot observe a PENDING row or interleave this device's ops.
    await repository.lockDevice(input.device_id);
    const operations = new OperationRepository(tx, ctx.organizationId);
    // Physical stock observations do not mutate crew availability. Mixed batches
    // retain the established schedule/task/actor lock order.
    if (input.ops.some(op => !["field_stocktake.record", "field_cash.collect", "field_cash.confirm_existing"].includes(op.type))) await operations.lock("crew-schedule");
    for (const taskId of [...new Set(input.ops.map(op => op.payload.taskId))].sort()) await operations.lock(taskId);
    const people = [ctx.personId, ...input.ops.flatMap(op => op.type === "field_task.proxy_validate" ? [op.payload.performedByPersonId] : [])];
    for (const personId of [...new Set(people)].sort()) await repository.lockActor(personId);
    const stocktakes = input.ops.flatMap(op => op.type === "field_stocktake.record" ? [op.payload] : []);
    let stocktakeBatch: Awaited<ReturnType<typeof prepareFieldStocktakeBatch>> | undefined;
    let stocktakeDenied = false;
    if (stocktakes.length) {
      try { stocktakeBatch = await prepareFieldStocktakeBatch(ctx, stocktakes, tx); }
      catch (error) { if (error instanceof ReservationAuthorizationError) stocktakeDenied = true; else throw error; }
    }
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
        if (op.type === "field_cash.confirm_existing") {
          const reviewed = await confirmExistingFieldCashInTransaction(ctx, op.payload, tx, metaForOp(deps, op), input.device_id);
          const result = appliedResult(op, reviewed.serverVersion);
          await repository.finish(input.device_id, op.client_op_id, result.status, result, null); results.push(result); continue;
        }
        if (op.type === "field_cash.collect") {
          const cash = await recordFieldCashInTransaction(ctx, op.payload, { deviceId: input.device_id, clientOpId: op.client_op_id,
            clientCreatedAt: op.client_created_at ? new Date(op.client_created_at) : null }, tx, metaForOp(deps, op));
          const result: SyncPushOpResult = { ...appliedResult(op, cash.serverVersion), status: cash.idempotent ? "DUPLICATE" : "APPLIED" };
          await repository.finish(input.device_id, op.client_op_id, result.status, result, null); results.push(result); continue;
        }
        if (op.type === "field_stocktake.record") {
          if (stocktakeDenied || !stocktakeBatch) throw new ReservationAuthorizationError();
          const observation = await recordFieldStocktakeInTransaction(ctx, op.payload, { deviceId: input.device_id,
            clientOpId: op.client_op_id, clientCreatedAt: op.client_created_at ? new Date(op.client_created_at) : null }, tx, stocktakeBatch, metaForOp(deps, op));
          const result = appliedResult(op, observation.serverVersion);
          await repository.finish(input.device_id, op.client_op_id, result.status, result, null);
          results.push(result); continue;
        }
        if (op.type === "field_task.issue.report") {
          const issue = await reportOperationIssueInTransaction(ctx, { ...op.payload, idempotencyKey: op.client_op_id }, tx, metaForOp(deps, op), true);
          const result: SyncPushOpResult = { ...appliedResult(op, null), status: issue.idempotent ? "DUPLICATE" : "APPLIED" };
          await repository.finish(input.device_id, op.client_op_id, result.status, result, null);
          results.push(result); continue;
        }
        if (op.type === "field_task.evidence.attach") {
          const attached = await attachFieldUploadEvidenceInTransaction(ctx, { ...op.payload, deviceId: input.device_id, idempotencyKey: op.client_op_id }, tx,
            { requestId: metaForOp(deps, op).requestId, ipAddress: deps.ipAddress ?? null });
          const result: SyncPushOpResult = { ...appliedResult(op, null), status: attached.idempotent ? "DUPLICATE" : "APPLIED" };
          await repository.finish(input.device_id, op.client_op_id, result.status, result, null);
          results.push(result); continue;
        }
        const completed = op.type === "field_task.proxy_validate"
          ? await proxyCompleteOperationTaskInTransaction(ctx, { ...op.payload, idempotencyKey: op.client_op_id }, tx, metaForOp(deps, op))
          : await completeAssignedFieldTaskInTransaction(
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
        const duplicateCompletion = op.type === "field_task.complete" && completed.completionIdempotencyKey !== op.client_op_id;
        const applied: SyncPushOpResult = duplicateCompletion
          ? { ...appliedResult(op, serverVersion), status: "DUPLICATE", error_code: "DUPLICATE_COMPLETION" }
          : appliedResult(op, serverVersion);
        await repository.finish(input.device_id, op.client_op_id, applied.status, applied, applied.error_code ?? null);
        results.push(applied);
      } catch (error) {
        if (error instanceof FieldCashConflictError) {
          const conflict: SyncPushOpResult = { client_op_id: op.client_op_id, status: "CONFLICT", server_version: error.current,
            conflict: { expected: error.expected, current: error.current, incoming: op.type }, error_code: "CASH_COLLECTION_CONFLICT" };
          await repository.finish(input.device_id, op.client_op_id, "CONFLICT", conflict, conflict.error_code!); results.push(conflict); continue;
        }
        if (error instanceof FieldCashUnavailableError) {
          const rejected = rejectedResult(op, `CASH_${error.code}`);
          await repository.finish(input.device_id, op.client_op_id, "REJECTED", rejected, rejected.error_code!); results.push(rejected); continue;
        }
        if (error instanceof StocktakeConflictError) {
          const conflict: SyncPushOpResult = { client_op_id: op.client_op_id, status: "CONFLICT", server_version: error.current.revision,
            error_code: "STOCKTAKE_CONFLICT", stocktake: { expected: error.expected, current: error.current } };
          await repository.finish(input.device_id, op.client_op_id, "CONFLICT", conflict, conflict.error_code!);
          results.push(conflict); continue;
        }
        if (error instanceof FieldStocktakeUnavailableError) {
          const rejected = rejectedResult(op, `STOCKTAKE_${error.code}`);
          await repository.finish(input.device_id, op.client_op_id, "REJECTED", rejected, rejected.error_code!);
          results.push(rejected); continue;
        }
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
