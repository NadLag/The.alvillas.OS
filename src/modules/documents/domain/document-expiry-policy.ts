import { z } from "zod";
import { Temporal } from "temporal-polyfill";
import { localizedTextSchema } from "@/i18n/content";

export const documentExpiryPolicyKey = "documents.expiry_reminders";
export const documentExpiryRoutingKey = "notification.routing.document_expiring";
const stage = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u),
  offset_days: z.number().int().min(-2147483647).max(2147483647),
  repeat_every_days: z.number().int().positive().max(2147483647).nullable(),
  labels: localizedTextSchema
}).strict();
export const documentExpiryPolicySchema = z.object({
  source: z.literal("NATIVE_DOCUMENT_VERSIONS"),
  calendar: z.literal("ORGANIZATION_PROFILE"),
  principal: z.literal("CURRENT_CONFIGURATION_AUTHOR"),
  version_selection: z.literal("CURRENT_EFFECTIVE_VERSION"),
  type_keys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u)).min(1).max(1000)
    .refine(values => new Set(values).size === values.length),
  change_admission: z.object({window_seconds:z.number().int().min(1).max(86400),max_requests:z.number().int().min(1).max(10000)}).strict(),
  send_at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  stages: z.array(stage).min(1).max(64)
}).strict().superRefine((value,ctx)=>{
  const keys = new Set<string>();
  for(const[index,item]of value.stages.entries()){
    if(keys.has(item.key))ctx.addIssue({code:"custom",path:["stages",index,"key"],message:"distinct_document_expiry_stage_required"});
    keys.add(item.key);
    if(index && item.offset_days <= value.stages[index-1].offset_days)ctx.addIssue({code:"custom",path:["stages",index,"offset_days"],message:"increasing_document_expiry_offsets_required"});
  }
});
const occurrenceInput = z.object({
  revisionId: z.uuid(), policyId: z.uuid(), on: z.iso.date(), dueOn: z.iso.date(),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
}).strict();

/** Polling is technical; every business threshold and civil send time is configured. */
export function documentExpiryOccurrence(rawPolicy: unknown, raw: unknown) {
  const policy = documentExpiryPolicySchema.parse(rawPolicy), value = occurrenceInput.parse(raw);
  const due = Temporal.PlainDate.from(value.dueOn), today = Temporal.PlainDate.from(value.on);
  const days = today.since(due, { largestUnit: "days" }).days;
  const selected = [...policy.stages].reverse().find(item => days >= item.offset_days);
  if(!selected)return null;
  const cycle = selected.repeat_every_days === null ? 0 : Math.floor((days-selected.offset_days)/selected.repeat_every_days);
  const offset = selected.offset_days + cycle * (selected.repeat_every_days ?? 0);
  const on = z.iso.date().parse(due.add({days:offset}).toString());
  if(on === value.on && value.localTime < policy.send_at)return null;
  return { stage: selected.key, on, labels: selected.labels,
    idempotencyKey: `document-expiry-reminder:${value.policyId}:${value.revisionId}:${selected.key}:${on}` };
}
