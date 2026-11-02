import{z}from"zod";
import{receivablePolicySchema}from"./receivable";
export const receivableCollectionPolicyKey="finance.receivable_collections";
const label=z.string().min(1).max(120).refine(value=>value.trim().length>0,"A method label must contain text");
export const receivableCollectionMethodSchema=z.object({key:z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),labels:z.object({en:label,fr:label,ar:label}).strict()}).strict();
export const receivableCollectionPolicySchema=z.object({source:z.literal("ACTUAL_RECEIPT_AGAINST_ORIGINAL_CLAIM"),destination_account_codes:receivablePolicySchema.shape.account_codes,
 bucket:z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u),received_date:z.literal("ON_OR_AFTER_ORIGINAL_POSTING"),closed_period:z.literal("REJECT"),correction_date:z.literal("CURRENT_OPEN_PERIOD"),
 payment_methods:z.array(receivableCollectionMethodSchema).min(1).refine(methods=>new Set(methods.map(method=>method.key)).size===methods.length,"Payment method keys must be unique")}).strict();
