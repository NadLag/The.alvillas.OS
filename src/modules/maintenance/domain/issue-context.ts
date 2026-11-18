import {z} from "zod";
import {nativeMaintenanceIssueInputSchema} from "@/platform/maintenance/issue-input";

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
/** Reuse the canonical field/task issue input, including its original nonce and
 * photo command. Linked records carry identities, never editable money. */
export const maintenanceIssueDraftSchema=z.object({issue:nativeMaintenanceIssueInputSchema,sources:maintenanceIssueSourcesSchema}).strict();
export class MaintenanceIssueAccessError extends Error{constructor(){super("maintenance_issue_unavailable");}}
export class MaintenanceIssueConflictError extends Error{constructor(){super("maintenance_issue_changed");}}
export class MaintenanceIssueSourceUnavailableError extends Error{constructor(readonly kind:MaintenanceIssueSource["kind"]){super("maintenance_issue_source_not_ready");}}
