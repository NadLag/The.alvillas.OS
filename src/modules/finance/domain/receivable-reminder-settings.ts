import{z}from"zod";
import{receivableReminderPolicySchema}from"./receivable-reminder-policy";
export const receivableReminderSettingsInput=z.object({expectedPolicyId:z.uuid().nullable(),policy:receivableReminderPolicySchema,reason:z.string().trim().min(6).max(500)}).strict();
const policy=z.object({id:z.uuid(),version:z.number().int().positive(),value:receivableReminderPolicySchema}).strict();
const lastRun=z.object({at:z.iso.datetime(),on:z.iso.date(),currency:z.string().regex(/^[A-Z]{3}$/u),occurrences:z.number().int().nonnegative(),notificationsRequested:z.number().int().nonnegative()}).strict();
export const receivableReminderSettingsSchema=z.object({source:z.discriminatedUnion("canConfigure",[
 z.object({canConfigure:z.literal(false)}).strict(),
 z.object({canConfigure:z.literal(true),timezone:z.string().nullable(),policy:policy.nullable(),routing:z.object({configured:z.boolean(),people:z.number().int().nonnegative(),roles:z.number().int().nonnegative(),channels:z.array(z.enum(["in_app","email","push"]))}).strict(),lastRun:lastRun.nullable()}).strict()
])}).strict();
export type ReceivableReminderSettings=z.infer<typeof receivableReminderSettingsSchema>;
