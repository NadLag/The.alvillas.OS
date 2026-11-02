import { z } from "zod";
import { companyExpenseDraftSchema, companyExpenseRevisionSchema, companyExpenseCancellationSchema } from "./company-expense";
import { companyExpenseInvoiceCommandSchema } from "./company-expense-invoice";
import { companyExpenseCompensationCommandSchema } from "./company-expense-compensation";

const id = z.uuid().transform(value => value.toLowerCase());
export const companyExpenseCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("CREATE"), idempotencyKey: id, input: companyExpenseDraftSchema.omit({ idempotencyKey: true }) }).strict(),
  z.object({ operation: z.literal("REVISE"), idempotencyKey: id, input: companyExpenseRevisionSchema }).strict(),
  z.object({ operation: z.literal("CANCEL"), idempotencyKey: id, input: companyExpenseCancellationSchema }).strict(),
  z.object({ operation: z.literal("INVOICE_SOURCE"), idempotencyKey: id, input: companyExpenseInvoiceCommandSchema }).strict(),
  z.object({ operation: z.literal("EMPLOYEE_SOURCE"), idempotencyKey: id, input: companyExpenseCompensationCommandSchema }).strict()
]);
export type CompanyExpenseCommand = z.infer<typeof companyExpenseCommandSchema>;
const identity = { requestId: id, idempotencyKey: id, operation: z.enum(["CREATE", "REVISE", "CANCEL", "INVOICE_SOURCE", "EMPLOYEE_SOURCE"]) };
export const companyExpenseCommandSuccessSchema = z.object({ ...identity, state: z.literal("SUCCEEDED"), failureCode: z.null(), companyExpenseId: id, resultId: id, version: z.number().int().positive(), idempotent: z.boolean() }).strict();
export const companyExpenseCommandResultSchema = z.discriminatedUnion("state", [
  companyExpenseCommandSuccessSchema,
  z.object({ ...identity, state: z.literal("CONFLICT"), failureCode: z.literal("SOURCE_CHANGED") }).strict(),
  z.object({ ...identity, state: z.literal("FAILED"), failureCode: z.literal("CONFIGURATION_UNAVAILABLE") }).strict()
]);
export const companyExpenseCommandRecoverySchema = z.object({ key: id }).strict();
