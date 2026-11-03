import {z} from "zod";
import {companyExpensePolicySchema} from "./company-expense";

const id=z.uuid(),labels=companyExpensePolicySchema.shape.categories.element.shape.labels;
export const companyExpenseWorkspaceReadSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("SETTINGS")}).strict(),
 z.object({operation:z.literal("LIST"),after:id.optional(),query:z.string().trim().max(120).optional(),state:z.enum(["PLANNED","CANCELLED"]).optional()}).strict(),
 z.object({operation:z.literal("DETAIL"),id,beforeVersion:z.number().int().positive().optional()}).strict(),
 z.object({operation:z.literal("INVOICE_HISTORY"),id,before:id.optional()}).strict(),
 z.object({operation:z.literal("EMPLOYEE_HISTORY"),id,before:id.optional()}).strict(),
 z.object({operation:z.literal("CANDIDATES"),id,kind:z.enum(["INVOICE","EMPLOYEE"]),after:id.optional(),query:z.string().trim().max(120).optional()}).strict()
]);
export const companyExpensePlanViewSchema=z.object({
 id,revisionId:id,version:z.number().int().positive(),state:z.enum(["PLANNED","CANCELLED"]),amount:z.string(),currency:z.string(),
 category:z.string(),costCenter:z.string(),purpose:z.string(),dueOn:z.iso.date(),timezone:z.string(),dataClass:z.enum(["FINANCIAL","STAFF_COMPENSATION"]),
 categoryLabels:labels,costCenterLabels:labels,reason:z.string(),at:z.iso.datetime({offset:true})
}).strict();
export const companyExpenseListSchema=z.object({items:z.array(companyExpensePlanViewSchema),next:id.nullable()}).strict();
export const companyExpenseDetailSchema=z.object({current:companyExpensePlanViewSchema,history:z.array(companyExpensePlanViewSchema),next:z.number().int().positive().nullable()}).strict();
export const companyExpenseWorkspaceSettingsSchema=z.object({
 timezone:z.string().nullable(),today:z.iso.date().nullable(),currencies:z.array(z.object({code:z.string(),minorUnit:z.number().int().nonnegative()})),
 categories:companyExpensePolicySchema.shape.categories,costCenters:companyExpensePolicySchema.shape.cost_centers,
 capabilities:z.object({create:z.boolean(),edit:z.boolean(),void:z.boolean(),staff:z.boolean(),invoice:z.boolean(),employee:z.boolean(),configure:z.boolean()})
}).strict();
const money=z.object({amount:z.string(),currency:z.string()}).strict();
const payment=z.object({id,amount:money,paidAt:z.iso.datetime({offset:true}),reason:z.string(),reference:z.string().nullable(),fundingName:z.string(),reversed:z.boolean()}).strict();
export const companyExpenseSourceHistorySchema=z.object({items:z.array(z.object({
 id,sourceId:id,version:z.number().int().positive(),planVersion:z.number().int().positive(),state:z.enum(["ATTACHED","RELEASED"]),active:z.boolean(),
 amount:z.string(),currency:z.string(),label:z.string(),reason:z.string(),at:z.iso.datetime({offset:true}),
 sourceReversed:z.boolean(),scope:z.enum(["INVOICE","EMPLOYEE_CLAIM"]),outstanding:money,payments:z.array(payment),paymentsNext:id.nullable(),
 invoiceId:id.optional(),submissionId:id.optional(),claimId:id.optional()
}).strict()),next:id.nullable()}).strict();
export const companyExpenseCandidatesSchema=z.object({items:z.array(z.object({id,label:z.string(),position:z.number().int().positive().optional(),amount:z.string(),currency:z.string(),sourceVersion:z.number().int().nonnegative()}).strict()),next:id.nullable()}).strict();
export type CompanyExpensePlanView=z.infer<typeof companyExpensePlanViewSchema>;
export type CompanyExpenseWorkspaceSettings=z.infer<typeof companyExpenseWorkspaceSettingsSchema>;
export type CompanyExpenseSourceHistory=z.infer<typeof companyExpenseSourceHistorySchema>;
