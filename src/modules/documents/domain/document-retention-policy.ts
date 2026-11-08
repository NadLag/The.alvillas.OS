import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";

export const documentRetentionPolicyKey="documents.retention";
export const documentRetentionTagKey=z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u);
const references=z.array(z.string().trim().min(1).max(1000)).max(32).refine(values=>new Set(values).size===values.length);
export const documentRetentionTagSchema=z.object({key:documentRetentionTagKey,labels:localizedTextSchema,blocks_disposition:z.boolean(),policy_references:references}).strict();
const jsonBytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Transport budgets bound private snapshots and their paginated history, independently of legal policy. */
export const documentRetentionTagsSchema=z.array(documentRetentionTagSchema).max(64).refine(value=>jsonBytes(value)<=65536);
export const documentRetentionPolicySchema=z.object({
  source:z.literal("NATIVE_DOCUMENT_VERSIONS"),
  artifact_inheritance:z.literal("ORIGINAL_SIGNED_VERSION"),
  archive_tagging:z.enum(["ALLOW","DENY"]),
  type_keys:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u)).min(1).max(1000).refine(values=>new Set(values).size===values.length),
  change_admission:z.object({window_seconds:z.number().int().min(1).max(86400),max_requests:z.number().int().min(1).max(10000)}).strict(),
  tags:z.array(documentRetentionTagSchema).min(1).max(1000).refine(values=>new Set(values.map(value=>value.key)).size===values.length)
}).strict().refine(value=>jsonBytes(value)<=262144);

export const documentRetentionSelectionSchema=z.array(documentRetentionTagKey).max(64)
  .refine(values=>new Set(values).size===values.length).transform(values=>[...values].sort());

/** References record the owner's configured policy context; they never constitute a legal approval. */
export function retainedDocumentTags(rawPolicy:unknown,rawKeys:unknown){
  const policy=documentRetentionPolicySchema.parse(rawPolicy),configured=new Map(policy.tags.map(tag=>[tag.key,tag])),keys=documentRetentionSelectionSchema
    .refine(keys=>keys.every(key=>configured.has(key)),{message:"document_retention_tag_unavailable"}).parse(rawKeys);
  return documentRetentionTagsSchema.parse(keys.map(key=>configured.get(key)!));
}

/** A real metadata input for the privacy workflow. Its native caller supplies identity and authorization. */
export function documentRetentionHookState(rawTags:unknown){
  const tags=documentRetentionTagsSchema.parse(rawTags);
  return{tagKeys:tags.map(tag=>tag.key).sort(),blocksDisposition:tags.some(tag=>tag.blocks_disposition),policyReferences:[...new Set(tags.flatMap(tag=>tag.policy_references))].sort(),
    disposition:"REQUIRES_OWNER_APPROVED_PRIVACY_WORKFLOW" as const};
}
