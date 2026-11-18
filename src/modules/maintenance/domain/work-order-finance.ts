import {z} from "zod";
const id=z.uuid(),money=z.object({amount:z.string().regex(/^-?\d+\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
/** References an original financial source; this record cannot post or pay it. */
export const workOrderExpenseSelectionSchema=z.object({taskId:id,expenseId:id}).strict();
export const workOrderExpenseSourceSchema=z.object({id,version:z.number().int().positive(),propertyId:id,reservationId:id.nullable(),state:z.string(),purpose:z.string(),category:z.string(),occurredOn:z.iso.date(),money,approvalId:id.nullable(),canEdit:z.boolean(),canSubmit:z.boolean()}).strict();

const reason = z.string().trim().min(6).max(1000);
const estimateFields = z.object({
  amount: z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/u).refine(value => /[1-9]/u.test(value)),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  category: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
  purpose: z.string().trim().min(6).max(1000),
  occurredOn: z.iso.date()
}).strict();
export const estimateSnapshotSchema = z.object({
  fields: estimateFields,
  allocation: z.object({ owner: money, alvillas: money, guest: money }),
  approvalSteps: z.array(z.string())
});
export const workOrderFinanceIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("estimate"), taskId: id, reason, expectedRevision: z.number().int().nonnegative(), fields: estimateFields }).strict(),
  z.object({ kind: z.literal("expense"), taskId: id, reason, sourceId: id }).strict(),
  z.object({ kind: z.literal("invoice"), taskId: id, reason, sourceId: id }).strict()
]);
export const workOrderFinanceCommandSchema = z.object({
  intent: workOrderFinanceIntentSchema,
  idempotencyKey: id,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const workOrderFinanceSourceSchema = z.object({
  id, version: z.number().int().nonnegative(), state: z.string(), label: z.string(),
  money, approvalId: id.nullable()
});
const estimateSchema = estimateSnapshotSchema.extend({
  kind: z.literal("estimate"),
  revision: z.number().int().positive(),
  approval: z.object({ id, state: z.enum(["PENDING", "APPROVED", "REJECTED"]) }).optional()
});
const evidenceSchema = z.object({ kind: z.enum(["expense", "invoice"]), source: workOrderFinanceSourceSchema });
export const workOrderFinanceReviewSchema = z.object({
  authorizationStamp: z.string(),
  fingerprint: workOrderFinanceCommandSchema.shape.fingerprint,
  detail: z.union([estimateSchema, evidenceSchema])
});
const visibleHistorySchema = z.object({
  id, reason, recordedAt: z.iso.datetime(),
  detail: z.union([estimateSchema, evidenceSchema]),
  recordedMoney: money,
  recordedSourceVersion: z.number().int().nonnegative().nullable()
});
export const workOrderFinanceHistorySchema = z.object({
  authorizationStamp: z.string(),
  latestRevision: z.number().int().nonnegative(),
  canEstimate: z.boolean(),
  canLink: z.boolean(),
  items: z.array(z.union([visibleHistorySchema, z.object({ masked: z.literal(true) })])),
  next: z.string().nullable()
});
export type WorkOrderFinanceIntent = z.infer<typeof workOrderFinanceIntentSchema>;

export const workOrderFinanceSearchSchema = z.object({
  taskId: id,
  kind: z.enum(["expense", "invoice"]),
  query: z.string().trim().min(2).max(120),
  cursor: z.string().max(6000).optional()
}).strict();
export const workOrderFinanceChoicesSchema = z.object({
  authorizationStamp: z.string(),
  items: z.array(workOrderFinanceSourceSchema).max(20),
  next: z.string().nullable()
});
