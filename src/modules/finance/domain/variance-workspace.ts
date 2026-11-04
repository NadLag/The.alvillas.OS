import { z } from "zod";
import { varianceSourceReferenceSchema, varianceWorkflowCommandSchema, varianceWorkflowVersionSchema } from "./variance-workflow";

const id = z.uuid().transform(value => value.toLowerCase()), version = varianceWorkflowVersionSchema, fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const explanation = z.string().max(2000), date = z.iso.datetime(), amount = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{2})?$/u);
export const varianceCommandInputSchema = z.object({ intent: varianceWorkflowCommandSchema, idempotencyKey: id }).strict();
export const varianceCommandReceiptSchema = z.object({ requestId: id, eventId: id, state: z.literal("SUCCEEDED"), failureCode: z.null(),
  idempotencyKey: id, source: varianceSourceReferenceSchema, version, operation: z.enum(["ASSIGN", "RESOLVE", "REOPEN"]),
  intent: varianceWorkflowCommandSchema, idempotent: z.boolean() }).strict().superRefine((value, context) => {
    if (value.requestId !== value.eventId || value.source.provider !== value.intent.source.provider || value.source.id !== value.intent.source.id ||
        value.operation !== value.intent.operation || !version.safeParse(value.version).success || !version.safeParse(value.intent.version).success ||
        BigInt(value.version) !== BigInt(value.intent.version) + 1n)
      context.addIssue({ code: "custom", message: "Complete original variance change acknowledgement required" });
  });
export type VarianceCommandReceipt = z.infer<typeof varianceCommandReceiptSchema>;
export const varianceDetailSchema = z.object({ version, source: varianceSourceReferenceSchema, sourceFingerprint: fingerprint,
  status: z.enum(["OPEN", "RESOLVED", "MATCHED", "SOURCE_CHANGED"]), assignedTo: id.nullable(), reason: explanation, action: explanation.nullable(),
  resolvedBy: id.nullable(), resolvedAt: date.nullable(), ageMilliseconds: z.string().regex(/^\d+$/u),
  facts: z.object({ kind: z.enum(["MONEY", "QUANTITY"]), unit: z.string().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
    expected: amount.max(200), actual: amount.max(200), variance: amount.max(200) }).strict().superRefine((value, context) => {
      if (value.kind === "MONEY" ? value.currency === null || value.unit !== "MONEY:" + value.currency ||
          [value.expected, value.actual, value.variance].some(value => !/^-?(?:0|[1-9]\d*)\.\d{2}$/u.test(value)) :
          value.currency !== null || !/^QUANTITY(?::.+)?$/u.test(value.unit) || [value.expected, value.actual, value.variance].some(value => !/^-?(?:0|[1-9]\d*)$/u.test(value)))
        context.addIssue({ code: "custom", message: "Retain original monetary or physical units and precision" });
    }) }).strict();
export const varianceHistorySchema = z.object({ rows: z.array(z.object({ id, version, operation: z.enum(["ASSIGN", "RESOLVE", "REOPEN"]),
  sourceFingerprint: fingerprint, status: z.enum(["OPEN", "RESOLVED"]), assignedTo: id.nullable(), actorId: id,
  reason: explanation, action: explanation.nullable(), resolvedBy: id.nullable(), resolvedAt: date.nullable(), createdAt: date }).strict()).max(50), next: version.nullable() }).strict();
export const varianceAssigneesSchema = z.object({ items: z.array(z.object({ id, name: z.string().max(500) }).strict()).max(50), next: id.nullable() }).strict();
