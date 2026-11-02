import {z} from "zod";
import {companyExpenseCancellationSchema} from "./company-expense";
export const companyExpenseInvoiceCommandSchema=z.object({
 operation:z.enum(["ATTACH","RELEASE"]),companyExpenseId:z.uuid().transform(value=>value.toLowerCase()),invoiceLineId:z.uuid().transform(value=>value.toLowerCase()),
 expectedSourceVersion:z.number().int().min(0),expectedPlanVersion:z.number().int().min(1),reason:companyExpenseCancellationSchema.shape.reason
}).strict();
export const companyExpenseInvoiceHistorySchema=z.object({companyExpenseId:z.uuid(),before:z.uuid().optional()}).strict();
