import {z} from "zod";
import {civilRecurrenceSchema} from "@/platform/time/configured-recurrence";
import {expenseDraftSchema} from "./expense-input";
export {nextCivilRecurrenceDate as nextRecurringExpenseDate,civilRecurrenceDue as recurringExpenseDue} from "@/platform/time/configured-recurrence";

export const recurringExpensePolicyKey="finance.recurring_expenses";
export const recurringExpenseScheduleSchema=civilRecurrenceSchema.safeExtend({id:z.uuid().transform(value=>value.toLowerCase()),
 draft:expenseDraftSchema.omit({occurredOn:true,idempotencyKey:true,reason:true,emergency:true}).extend({
  propertyId:expenseDraftSchema.shape.propertyId.transform(value=>value.toLowerCase()),fundingAccountId:expenseDraftSchema.shape.fundingAccountId.transform(value=>value.toLowerCase()),
  reservationId:expenseDraftSchema.shape.propertyId.transform(value=>value.toLowerCase()).optional()
 })
}).strict();
export const recurringExpensePolicySchema=z.object({
 source:z.literal("PROPERTY_EXPENSE_DRAFT"),principal:z.literal("CURRENT_CONFIGURATION_AUTHOR"),
 batch_size:z.number().int().min(1).max(500),expenses:z.array(recurringExpenseScheduleSchema).max(10000)
}).strict().refine(value=>new Set(value.expenses.map(item=>item.id)).size===value.expenses.length,{message:"Schedule identities must be distinct"});
export type RecurringExpenseSchedule=z.infer<typeof recurringExpenseScheduleSchema>;

export class RecurringExpenseAccessError extends Error{}
export class RecurringExpenseConfigurationError extends Error{}
