import { z } from "zod";
import { companyExpenseInvoiceCommandSchema, companyExpenseInvoiceHistorySchema } from "./company-expense-invoice";

/** Reuse the existing append-only company-source command contract and reason validation. */
export const companyExpenseCompensationCommandSchema = companyExpenseInvoiceCommandSchema.omit({ invoiceLineId: true }).extend({
  employeeCostId: z.uuid().transform(value => value.toLowerCase())
}).strict();
export const companyExpenseCompensationHistorySchema = companyExpenseInvoiceHistorySchema;
