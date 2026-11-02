import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";

export const receivableAgingPolicyKey="finance.receivable_aging";
export const receivableAgingPolicySchema=z.object({
 source:z.literal("ORIGINAL_ASSIGNMENTS_AND_POSTED_COLLECTIONS"),
 calendar:z.literal("ORGANIZATION_PROFILE"),
 unscheduled:z.literal("SEPARATE"),
 bands:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
  from_days:z.number().int().positive(),through_days:z.number().int().positive().nullable(),
  labels:localizedTextSchema.strict()}).strict()).min(1).max(32)
}).strict().superRefine((policy,ctx)=>{
 const keys=new Set<string>();
 for(const[at,band]of policy.bands.entries()){
  if(keys.has(band.key))ctx.addIssue({code:"custom",path:["bands",at,"key"],message:"Aging band keys must be unique"});keys.add(band.key);
  const previous=policy.bands[at-1],expected=at===0?1:previous.through_days===null?null:previous.through_days+1;
  if(expected===null||band.from_days!==expected||band.through_days!==null&&band.through_days<band.from_days||at<policy.bands.length-1&&band.through_days===null||at===policy.bands.length-1&&band.through_days!==null)
   ctx.addIssue({code:"custom",path:["bands",at],message:"Aging bands must cover every overdue day once, starting at one and ending without a limit"});
 }
});
export type ReceivableAgingPolicy=z.infer<typeof receivableAgingPolicySchema>;
