import {z} from "zod";
import {leadStageDraftSchema,leadPipelineEvidenceKinds,LeadPipelineEvidenceError} from "./lead-pipeline";

const uuid=z.uuid().transform(value=>value.toLowerCase());
export const leadStageEvidenceChoicesInputSchema=leadStageDraftSchema.extend({
 documentId:uuid.optional(),signatureId:uuid.optional(),cursor:z.string().min(1).max(6000).optional()
}).strict().refine(value=>!(value.documentId&&value.signatureId));
const document=z.object({kind:z.literal("DOCUMENT"),id:uuid,title:z.string(),locale:z.enum(["en","fr","ar"])}).strict();
const signature=z.object({kind:z.literal("SIGNATURE"),id:uuid,state:z.enum(["DRAFT","SENT","VIEWED","SIGNED","DECLINED","EXPIRED"]),createdAt:z.iso.datetime()}).strict();
const evidence=z.object({kind:z.literal("EVIDENCE"),id:uuid,evidenceKind:z.enum(leadPipelineEvidenceKinds),occurredAt:z.iso.datetime(),title:z.string().optional(),number:z.number().int().positive().optional()}).strict();
export const leadStageEvidenceChoicesSchema=z.object({protocol:z.literal("NATIVE_LEAD_STAGE_EVIDENCE_CHOICES_V1"),leadId:uuid,previousRevisionId:uuid.nullable(),toStage:leadStageDraftSchema.shape.toStage,
 required:z.array(z.enum(leadPipelineEvidenceKinds)).max(leadPipelineEvidenceKinds.length),selected:leadStageDraftSchema.shape.evidenceReferences.unwrap(),
 nextKind:z.enum(leadPipelineEvidenceKinds).nullable(),items:z.array(z.discriminatedUnion("kind",[document,signature,evidence])).max(50),next:z.string().nullable(),dependency:z.literal("F-ONB-07").nullable()
}).strict().superRefine((value,context)=>{
 const prefix=leadPipelineEvidenceKinds.filter(kind=>value.required.includes(kind));
 if(new Set(value.required).size!==value.required.length||JSON.stringify(prefix)!==JSON.stringify(value.required)||value.selected.length>prefix.length||value.selected.some((reference,index)=>reference.kind!==prefix[index])||value.nextKind!==(prefix[value.selected.length]??null))context.addIssue({code:"custom",message:"exact_native_selection_prefix_required"});
 if(value.dependency&&value.nextKind!=="ONBOARDING_RELEASE"||value.nextKind===null&&(value.items.length>0||value.next!==null)||value.items.some(item=>item.kind==="DOCUMENT"?!["PROPOSAL_VERSION","CONTRACT_VERSION"].includes(value.nextKind??""):item.kind==="SIGNATURE"?value.nextKind!=="SIGNATURE_SENT":item.evidenceKind!==value.nextKind))context.addIssue({code:"custom",message:"matching_native_evidence_catalog_required"});
});
export type LeadStageEvidenceChoicesInput=z.infer<typeof leadStageEvidenceChoicesInputSchema>;
export type LeadStageEvidenceChoices=z.infer<typeof leadStageEvidenceChoicesSchema>;

/** A selection is an ordered prefix of the exact configured edge; references never assert completion. */
export function leadStageEvidencePrefix(required:readonly typeof leadPipelineEvidenceKinds[number][],draft:z.infer<typeof leadStageDraftSchema>){
 const ordered=leadPipelineEvidenceKinds.filter(kind=>required.includes(kind)),references=draft.evidenceReferences??[];
 if(references.length>ordered.length||references.some((reference,index)=>reference.kind!==ordered[index]))throw new LeadPipelineEvidenceError();
 return{required:ordered,selected:references,nextKind:ordered[references.length]??null};
}
