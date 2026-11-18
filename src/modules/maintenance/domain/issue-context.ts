import {z} from "zod";

const id=z.uuid().transform(value=>value.toLowerCase());
const record=z.object({kind:z.enum(["PROPERTY","RESERVATION","GUEST","TASK","PERSON","SUPPLIER","EXPENSE","ASSET"]),id}).strict();
const document=z.object({kind:z.enum(["PHOTO","DOCUMENT"]),provider:z.literal("DOCUMENT_VERSION"),id}).strict();
const fieldPhoto=z.object({kind:z.literal("PHOTO"),provider:z.literal("FIELD_EVIDENCE"),id}).strict();
export const maintenanceIssueSourceSchema=z.union([record,document,fieldPhoto]);
export type MaintenanceIssueSource=z.infer<typeof maintenanceIssueSourceSchema>;
export function maintenanceIssueSourceKey(source:MaintenanceIssueSource){return source.kind+":"+("provider" in source?source.provider+":":"")+source.id;}
export const maintenanceIssueSourcesSchema=z.array(maintenanceIssueSourceSchema).max(50).superRefine((sources,context)=>{
 if(new Set(sources.map(maintenanceIssueSourceKey)).size!==sources.length)context.addIssue({code:"custom",message:"Each original issue context appears once"});
});
export class MaintenanceIssueAccessError extends Error{constructor(){super("maintenance_issue_unavailable");}}
export class MaintenanceIssueConflictError extends Error{constructor(){super("maintenance_issue_changed");}}
export class MaintenanceIssueSourceUnavailableError extends Error{constructor(readonly kind:MaintenanceIssueSource["kind"]){super("maintenance_issue_source_not_ready");}}
const version=z.string().regex(/^(?:0|[1-9]\d{0,18})$/u).refine(value=>/^(?:0|[1-9]\d{0,18})$/u.test(value)&&BigInt(value)<=9223372036854775807n),hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const maintenanceIssueLinkIntentSchema=z.object({issueId:id,expectedVersion:version,operation:z.enum(["ATTACH","DETACH"]),source:maintenanceIssueSourceSchema,reason:z.string().trim().min(6).max(500)}).strict();
export const maintenanceIssueLinkCommandSchema=z.object({intent:maintenanceIssueLinkIntentSchema,reviewFingerprint:hash,idempotencyKey:id}).strict();
export const maintenanceIssueLinkReceiptSchema=z.object({schemaVersion:z.literal(1),organizationId:id,actorId:id,contextId:id,previousId:id.nullable(),version:version.refine(value=>value!=="0"),intent:maintenanceIssueLinkIntentSchema,idempotencyKey:id,requestHash:hash,reviewFingerprint:hash,nativeFingerprint:hash,sourceFingerprint:hash,createdAt:z.iso.datetime()}).strict().superRefine((value,context)=>{
 if(!version.safeParse(value.version).success||!version.safeParse(value.intent.expectedVersion).success)return;
 if(BigInt(value.version)!==BigInt(value.intent.expectedVersion)+1n||(value.version==="1")!==(value.previousId===null))context.addIssue({code:"custom",message:"Preserve the exact original issue-context sequence"});
});
export type MaintenanceIssueLinkReceipt=z.infer<typeof maintenanceIssueLinkReceiptSchema>;
export const maintenanceIssueLinkPublishedSchema=maintenanceIssueLinkReceiptSchema.safeExtend({replayed:z.boolean()}).strict();
export const maintenanceIssueLinkCancellationSchema=z.object({schemaVersion:z.literal(1),organizationId:id,actorId:id,issueId:id,idempotencyKey:id}).strict();
const acknowledgement={organizationId:id,actorId:id,issueId:id,idempotencyKey:id};
export const maintenanceIssueCommandStatusSchema=z.discriminatedUnion("state",[
 z.object({...acknowledgement,state:z.literal("RECORDED"),contextId:id,version:version.refine(value=>value!=="0")}).strict(),
 z.object({...acknowledgement,state:z.enum(["CANCELLED","UNKNOWN"])}).strict()
]);
