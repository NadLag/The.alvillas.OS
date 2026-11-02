import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";

export const receivableReminderPolicyKey="finance.receivable_reminders";
export const receivableReminderRoutingKey="notification.routing.receivable_reminder";
const stage=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u),offset_days:z.number().int().min(-2147483647).max(2147483647),repeat_every_days:z.number().int().positive().max(2147483647).nullable(),labels:localizedTextSchema}).strict();
/** Every threshold, repeat interval and local send time is an explicit company rule. */
export const receivableReminderPolicySchema=z.object({source:z.literal("CURRENT_ORIGINAL_AGING"),calendar:z.literal("ORGANIZATION_PROFILE"),principal:z.literal("CURRENT_CONFIGURATION_AUTHOR"),send_at:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),stages:z.array(stage).min(1).max(64)}).strict().superRefine((value,ctx)=>{
 const keys=new Set<string>();for(const[index,item]of value.stages.entries()){if(keys.has(item.key))ctx.addIssue({code:"custom",path:["stages",index,"key"],message:"Each reminder stage must have its own key"});keys.add(item.key);if(index&&item.offset_days<=value.stages[index-1].offset_days)ctx.addIssue({code:"custom",path:["stages",index,"offset_days"],message:"Reminder stages must use strictly increasing civil-day offsets"});}
});
export type ReceivableReminderPolicy=z.infer<typeof receivableReminderPolicySchema>;
