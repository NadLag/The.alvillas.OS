import {z} from "zod";
import {companyExpensePolicySchema,recurringCompanyExpenseScheduleSchema} from "./company-expense";
const common={expectedPolicyId:z.uuid().nullable(),reason:z.string().trim().min(6).max(500)};
export const companyExpenseSettingsCommandSchema=z.discriminatedUnion("operation",[
 z.object({...common,operation:z.literal("INITIALIZE"),policy:companyExpensePolicySchema}).strict(),
 z.object({...common,operation:z.literal("CATEGORY"),category:companyExpensePolicySchema.shape.categories.element}).strict(),
 z.object({...common,operation:z.literal("COST_CENTER"),costCenter:companyExpensePolicySchema.shape.cost_centers.element}).strict(),
 z.object({...common,operation:z.literal("SCHEDULE"),schedule:recurringCompanyExpenseScheduleSchema,batchSize:z.number().int().min(1).max(500)}).strict(),
 z.object({...common,operation:z.literal("REMOVE_SCHEDULE"),scheduleId:z.uuid(),batchSize:z.number().int().min(1).max(500)}).strict()
]);
export const companyExpenseSettingsSchema=z.object({policyId:z.uuid().nullable(),policy:companyExpensePolicySchema.nullable(),recurringPolicyId:z.uuid().nullable(),batchSize:z.number().int().positive().nullable(),schedules:z.array(recurringCompanyExpenseScheduleSchema)}).strict();
export type CompanyExpenseSettings=z.infer<typeof companyExpenseSettingsSchema>;
