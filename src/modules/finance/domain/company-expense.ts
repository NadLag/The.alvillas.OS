import {z} from "zod";
import {civilRecurrenceSchema} from "@/platform/time/configured-recurrence";
import {expenseDraftSchema} from "./expense-input";

export const companyExpensePolicyKey="finance.company_expenses";
export const recurringCompanyExpensePolicyKey="finance.recurring_company_expenses";
const key=expenseDraftSchema.shape.category;
const labels=z.object({en:z.string().trim().min(1).max(120),fr:z.string().trim().min(1).max(120),ar:z.string().trim().min(1).max(120)}).strict();
const distinct=<T extends{key:string}>(rows:T[])=>new Set(rows.map(row=>row.key)).size===rows.length;
export const companyExpensePolicySchema=z.object({
 categories:z.array(z.object({key,labels,data_class:z.enum(["FINANCIAL","STAFF_COMPENSATION"])}).strict()).min(1).max(10000).refine(distinct),
 cost_centers:z.array(z.object({key,labels}).strict()).min(1).max(10000).refine(distinct)
}).strict();
/** A company cost plan has no property attribution and does not fabricate an invoice or payment. */
export const companyExpenseDraftSchema=expenseDraftSchema.pick({amount:true,currency:true,category:true,purpose:true,idempotencyKey:true,reason:true}).extend({
 costCenter:key,dueOn:z.iso.date()
}).strict();
export const companyExpenseRevisionSchema=companyExpenseDraftSchema.omit({idempotencyKey:true}).extend({id:z.uuid(),expectedVersion:z.number().int().min(1)}).strict();
export const companyExpenseCancellationSchema=z.object({id:z.uuid(),expectedVersion:z.number().int().min(1),reason:expenseDraftSchema.shape.reason}).strict();
export const recurringCompanyExpenseScheduleSchema=civilRecurrenceSchema.safeExtend({
 id:z.uuid().transform(value=>value.toLowerCase()),draft:companyExpenseDraftSchema.omit({dueOn:true,idempotencyKey:true,reason:true})
}).strict();
export const recurringCompanyExpensePolicySchema=z.object({
 source:z.literal("COMPANY_EXPENSE_PLAN"),principal:z.literal("CURRENT_CONFIGURATION_AUTHOR"),batch_size:z.number().int().min(1).max(500),
 expenses:z.array(recurringCompanyExpenseScheduleSchema).max(10000)
}).strict().refine(value=>new Set(value.expenses.map(item=>item.id)).size===value.expenses.length,{message:"Schedule identities must be distinct"});
export type CompanyExpenseDraftInput=z.infer<typeof companyExpenseDraftSchema>;
export type CompanyExpensePolicy=z.infer<typeof companyExpensePolicySchema>;
export class CompanyExpenseAccessError extends Error{}
export class CompanyExpenseConfigurationError extends Error{}
export class CompanyExpenseChangedError extends Error{}
