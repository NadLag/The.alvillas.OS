import {z} from "zod";
import {recurringExpenseScheduleSchema} from "./recurring-expense";
export const recurringExpenseSettingsCommandSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("SAVE"),schedule:recurringExpenseScheduleSchema,expectedPolicyId:z.uuid().nullable(),batchSize:z.number().int().min(1).max(500),reason:z.string().trim().min(6).max(500)}).strict(),
 z.object({operation:z.literal("REMOVE"),scheduleId:z.uuid(),expectedPolicyId:z.uuid(),batchSize:z.number().int().min(1).max(500),reason:z.string().trim().min(6).max(500)}).strict()
]);
export const recurringExpenseSettingsSchema=z.object({
 property:z.object({id:z.uuid(),name:z.string(),timezone:z.string()}),currencies:z.array(z.string()),
 policyId:z.uuid().nullable(),batchSize:z.number().int().positive().nullable(),schedules:z.array(recurringExpenseScheduleSchema),
 history:z.array(z.object({id:z.uuid(),scheduleId:z.uuid(),on:z.iso.date(),expenseId:z.uuid(),at:z.iso.datetime({offset:true})}))
}).strict();
export type RecurringExpenseSettings=z.infer<typeof recurringExpenseSettingsSchema>;
export class RecurringExpenseChangedError extends Error{}
