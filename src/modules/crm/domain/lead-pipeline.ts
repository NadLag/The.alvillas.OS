import {z} from "zod";

export const leadPipelinePolicyKey="crm.pipeline";
export const leadStages=["NEW","CONTACTED","QUALIFIED","PROPERTY_ASSESSMENT","PROPOSAL","CONTRACT_DRAFT","SENT","VIEWED","SIGNED","ALVILLAS_ONBOARDING","GO_LIVE"] as const;
export type LeadStage=typeof leadStages[number];
export const leadStageSchema=z.enum(leadStages);
export const leadPipelineEvidenceKinds=["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE","OWNER_CONVERSION","ONBOARDING_RELEASE"]as const;
export type LeadPipelineEvidenceKind=typeof leadPipelineEvidenceKinds[number];
const uuid=z.uuid().transform(value=>value.toLowerCase());
const sha256=z.string().regex(/^[a-f0-9]{64}$/u);
const distinct=<T,>(values:T[])=>new Set(values).size===values.length;

/** These are the locked product stages' proof requirements, never caller assertions. */
const minimumEvidence:Record<LeadStage,readonly LeadPipelineEvidenceKind[]>={
  NEW:[],CONTACTED:[],QUALIFIED:[],PROPERTY_ASSESSMENT:[],PROPOSAL:["PROPOSAL_VERSION"],
  CONTRACT_DRAFT:["PROPOSAL_VERSION","CONTRACT_VERSION"],SENT:["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT"],
  VIEWED:["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED"],
  SIGNED:["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE"],
  ALVILLAS_ONBOARDING:["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE","OWNER_CONVERSION"],
  GO_LIVE:leadPipelineEvidenceKinds
};
const transitionSchema=z.object({
  from:leadStageSchema,to:leadStageSchema,kind:z.enum(["ADVANCE","CORRECTION"]),
  evidence:z.array(z.enum(leadPipelineEvidenceKinds)).max(leadPipelineEvidenceKinds.length).refine(distinct)
}).strict().superRefine((edge,context)=>{
  const from=leadStages.indexOf(edge.from),to=leadStages.indexOf(edge.to);
  if(edge.kind==="ADVANCE"?to!==from+1:to>=from)context.addIssue({code:"custom",message:"ordered_approved_lead_stage_required"});
  for(const kind of minimumEvidence[edge.to])if(!edge.evidence.includes(kind))context.addIssue({code:"custom",path:["evidence"],message:"native_lead_stage_evidence_required"});
});
export const leadPipelineTransitionSchema=transitionSchema;
export const leadPipelinePolicySchema=z.object({
  source:z.literal("NATIVE_IMMUTABLE_LEAD_PIPELINE"),history:z.literal("APPEND_ONLY_STAGE_MOVEMENTS"),
  document_types:z.object({
    proposal:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u)).min(1).max(100).refine(distinct),
    contract:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u)).min(1).max(100).refine(distinct)
  }).strict().refine(value=>!value.proposal.some(key=>value.contract.includes(key))),
  transitions:z.array(transitionSchema).min(1).max(leadStages.length*(leadStages.length-1)).refine(values=>distinct(values.map(edge=>edge.from+":"+edge.to))),
  admission:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
export type LeadPipelinePolicy=z.infer<typeof leadPipelinePolicySchema>;

export const leadStageDraftSchema=z.object({leadId:uuid,previousRevisionId:uuid.nullable(),toStage:leadStageSchema,
  evidenceReferences:z.array(z.object({kind:z.enum(leadPipelineEvidenceKinds),sourceId:uuid}).strict()).max(leadPipelineEvidenceKinds.length).refine(values=>distinct(values.map(value=>value.kind))).optional()
}).strict();
export const leadStageReasonSchema=z.string().trim().min(1).max(1000).refine(value=>!/\p{Cc}/u.test(value)).transform(value=>value.normalize("NFC"));
export const leadStageCommandSchema=leadStageDraftSchema.extend({idempotencyKey:uuid,reviewFingerprint:sha256,
  reason:leadStageReasonSchema
}).strict();
export type LeadStageDraft=z.infer<typeof leadStageDraftSchema>;
export type LeadStageCommand=z.infer<typeof leadStageCommandSchema>;
export type LeadStagePosition={stage:LeadStage;revisionId:string|null};

/** Stable protocol projection also equates absent and empty technical references. */
export function canonicalLeadStageDraft(raw:unknown){
  const input=leadStageDraftSchema.parse(raw);
  return{leadId:input.leadId,previousRevisionId:input.previousRevisionId,toStage:input.toStage,evidenceReferences:[...(input.evidenceReferences??[])].sort((left,right)=>leadPipelineEvidenceKinds.indexOf(left.kind)-leadPipelineEvidenceKinds.indexOf(right.kind))};
}
export function canonicalLeadStageCommand(raw:unknown){
  const input=leadStageCommandSchema.parse(raw);
  return{...canonicalLeadStageDraft({leadId:input.leadId,previousRevisionId:input.previousRevisionId,toStage:input.toStage,evidenceReferences:input.evidenceReferences}),idempotencyKey:input.idempotencyKey,reviewFingerprint:input.reviewFingerprint,reason:input.reason};
}

/** Only repository-derived proof snapshots reach this boundary; HTTP accepts references alone. */
export const nativeLeadStageProofSchema=z.object({
  kind:z.enum(leadPipelineEvidenceKinds),organizationId:uuid,leadId:uuid,sourceId:uuid,sourceFingerprint:sha256,occurredAt:z.iso.datetime()
}).strict();
export type NativeLeadStageProof=z.infer<typeof nativeLeadStageProofSchema>;

export function configuredLeadTransition(current:LeadStagePosition,raw:unknown,policyInput:unknown){
  const input=leadStageDraftSchema.parse(raw),policy=leadPipelinePolicySchema.parse(policyInput);
  // NEW can also be reached by an explicit immutable correction.
  if(current.revisionId===null&&current.stage!=="NEW")throw new LeadPipelineConflictError();
  if(current.revisionId!==input.previousRevisionId)throw new LeadPipelineConflictError();
  const transition=policy.transitions.find(edge=>edge.from===current.stage&&edge.to===input.toStage);
  if(!transition)throw new LeadPipelineValidationError();
  return{input,transition};
}

export function requireNativeLeadStageProofs(organizationId:string,leadId:string,required:readonly LeadPipelineEvidenceKind[],raw:unknown,now:Date){
  const tenant=uuid.parse(organizationId),lead=uuid.parse(leadId),proofs=z.array(nativeLeadStageProofSchema).max(leadPipelineEvidenceKinds.length).parse(raw);
  if(!Number.isFinite(now.getTime())||!distinct(proofs.map(proof=>proof.kind))||proofs.some(proof=>proof.organizationId!==tenant||proof.leadId!==lead||Date.parse(proof.occurredAt)>now.getTime())||required.some(kind=>!proofs.some(proof=>proof.kind===kind)))throw new LeadPipelineEvidenceError();
  return [...proofs].sort((left,right)=>leadPipelineEvidenceKinds.indexOf(left.kind)-leadPipelineEvidenceKinds.indexOf(right.kind));
}

export class LeadPipelineValidationError extends Error{constructor(){super("lead_pipeline_validation");}}
export class LeadPipelineConflictError extends Error{constructor(){super("lead_pipeline_changed");}}
export class LeadPipelineEvidenceError extends Error{constructor(){super("lead_pipeline_native_evidence_required");}}
