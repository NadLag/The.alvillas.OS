import { z } from "zod";
import { bankReconciliationMatchInput, bankReconciliationReleaseInput } from "./bank-reconciliation";

const exactNumber = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u).max(200);
const allocation = z.object({ sourceKey: z.uuid(), original: exactNumber, allocatedBefore: exactNumber, amount: exactNumber }).strict();
export const bankReconciliationPlanSchema = z.object({ unit: z.string().regex(/^MONEY:[A-Z]{3}$/u), expected: exactNumber, actual: exactNumber, variance: exactNumber,
  classification: z.enum(["EXACT", "WITHIN_TOLERANCE", "OUTSIDE_TOLERANCE"]), reason: z.string().min(8).max(2000), varianceAction: z.string().min(8).max(2000).nullable(),
  allocations: z.object({ expected: z.array(allocation).min(1).max(500), actual: z.array(allocation).max(500) }).strict(),
  evidence: z.array(z.object({ side: z.literal("ACTUAL"), sourceKey: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(500) }).strict().superRefine((value, context) => {
    if (value.allocations.actual.length === 0 ? value.evidence.length === 0 : value.evidence.length !== 0)
      context.addIssue({ code: "custom", message: "An empty actual side requires retained bank removal evidence" });
  });
export const bankReconciliationStateSchema = z.enum(["MATCHED", "OPEN_VARIANCE", "SOURCE_CHANGED", "RELEASED"]);
export const bankReconciliationResultSchema = z.object({ id: z.uuid(), accountId: z.uuid(), action: z.enum(["MATCH", "RELEASE"]), state: bankReconciliationStateSchema,
  releasedById: z.uuid().nullable().optional(), originalId: z.uuid().optional(), plan: bankReconciliationPlanSchema }).strict();
export const bankReconciliationCommandInput = z.discriminatedUnion("action", [bankReconciliationMatchInput, bankReconciliationReleaseInput]);
export const bankReconciliationCommandReceiptSchema = z.object({ requestId: z.uuid(), idempotencyKey: z.uuid(), operation: z.enum(["MATCH", "RELEASE"]),
  state: z.literal("SUCCEEDED"), failureCode: z.null(), result: bankReconciliationResultSchema }).strict().superRefine((value, context) => {
  if (value.requestId !== value.result.id || value.operation !== value.result.action) context.addIssue({ code: "custom", message: "Original matching command acknowledgement required" });
});
export const bankReconciliationCommandRecoverySchema = z.object({ request: bankReconciliationCommandReceiptSchema.nullable() }).strict();
export type BankReconciliationCommandReceipt = z.infer<typeof bankReconciliationCommandReceiptSchema>;
