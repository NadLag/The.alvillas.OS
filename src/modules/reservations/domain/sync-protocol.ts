import { z } from "zod";
import { proxyCompleteTaskSchema, issueInputSchema } from "./operation-task";
import { fieldStocktakePayloadSchema, type StockPosition } from "@/platform/inventory/field-stocktake";
import { fieldCashPayloadSchema, fieldCashConfirmSchema } from "@/platform/ledger/field-cash";

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

export const syncOpStatusSchema = z.enum(["APPLIED", "DUPLICATE", "CONFLICT", "REJECTED"]);

export const fieldTaskCompletePayloadSchema = z.object({
  taskId: z.string().uuid(),
  checklistItemIds: z.array(z.string().uuid()).min(1).max(50),
  note: optionalText(1000)
});

const syncOpEnvelope = z.object({
  client_op_id: z.string().uuid(),
  base_version: z.string().trim().max(120).optional(),
  client_created_at: z.string().datetime({ offset: true }).optional()
});
export const fieldTaskCompleteOpSchema = syncOpEnvelope.extend({
  type: z.literal("field_task.complete"), payload: fieldTaskCompletePayloadSchema
});
export const fieldTaskEvidenceAttachOpSchema = fieldTaskCompleteOpSchema.extend({
  type: z.literal("field_task.evidence.attach"),
  payload: z.object({ taskId: z.uuid(), uploadId: z.uuid() }).strict()
});
export const syncPushOpSchema = z.discriminatedUnion("type", [
  fieldTaskCompleteOpSchema, fieldTaskEvidenceAttachOpSchema,
  syncOpEnvelope.extend({ type: z.literal("field_task.issue.report"), payload: issueInputSchema.omit({ idempotencyKey: true }) }).strict(),
  syncOpEnvelope.extend({ type: z.literal("field_stocktake.record"), payload: fieldStocktakePayloadSchema }).strict(),
  syncOpEnvelope.extend({ type: z.literal("field_cash.collect"), payload: fieldCashPayloadSchema }).strict(),
  syncOpEnvelope.extend({ type: z.literal("field_cash.confirm_existing"), payload: fieldCashConfirmSchema }).strict(),
  syncOpEnvelope.extend({ type: z.literal("field_task.proxy_validate"), payload: proxyCompleteTaskSchema.omit({ idempotencyKey: true }) }).strict()
]);

export const syncPushInputSchema = z.object({
  device_id: z.string().trim().min(8).max(160),
  organization_id: z.string().uuid(),
  actor_user_id: z.string().uuid(),
  op_schema_version: z.literal(1),
  ops: z.array(syncPushOpSchema).min(1).max(50)
});

export type SyncPushInput = z.infer<typeof syncPushInputSchema>;
export type SyncPushOp = z.infer<typeof syncPushOpSchema>;
export type SyncOpStatus = z.infer<typeof syncOpStatusSchema>;

export type SyncPushOpResult = {
  client_op_id: string;
  status: SyncOpStatus;
  server_version: string | null;
  conflict?: {
    expected: string | null;
    current: string;
    incoming: string;
  };
  error_code?: string;
  stocktake?: { expected: StockPosition; current: StockPosition };
};

export type SyncPushResult = {
  op_schema_version: 1;
  results: SyncPushOpResult[];
};
