import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {configuredLeadTransition,leadStages,leadPipelineEvidenceKinds,leadPipelinePolicySchema,leadStageCommandSchema,requireNativeLeadStageProofs,type LeadPipelinePolicy,type NativeLeadStageProof} from "@/modules/crm/domain/lead-pipeline";

const organizationId=randomUUID(),leadId=randomUUID(),now=new Date("2030-01-01T12:00:00Z");
const policy=():LeadPipelinePolicy=>({source:"NATIVE_IMMUTABLE_LEAD_PIPELINE",history:"APPEND_ONLY_STAGE_MOVEMENTS",admission:{requests:10,window_seconds:60},transitions:leadStages.slice(0,-1).map((from,index)=>({from,to:leadStages[index+1],kind:"ADVANCE",evidence:[...leadPipelineEvidenceKinds]}))});
const proof=(kind:NativeLeadStageProof["kind"]):NativeLeadStageProof=>({kind,organizationId,leadId,sourceId:randomUUID(),sourceFingerprint:"a".repeat(64),occurredAt:"2030-01-01T11:00:00Z"});

describe("configured immutable acquisition pipeline",()=>{
  it("preserves every approved stage in its exact product order",()=>{
    expect(leadStages).toEqual(["NEW","CONTACTED","QUALIFIED","PROPERTY_ASSESSMENT","PROPOSAL","CONTRACT_DRAFT","SENT","VIEWED","SIGNED","ALVILLAS_ONBOARDING","GO_LIVE"]);expect(leadPipelinePolicySchema.parse(policy()).transitions).toHaveLength(10);
  });
  it.each(leadStages.slice(0,-1))("allows the configured immediate advance from %s with the original optimistic revision",from=>{
    const index=leadStages.indexOf(from),revisionId=index?randomUUID():null,input={leadId,previousRevisionId:revisionId,toStage:leadStages[index+1]};expect(configuredLeadTransition({stage:from,revisionId},input,policy()).input).toEqual(input);
  });
  it("denies an unconfigured transition and any attempt to skip stages",()=>{
    expect(()=>configuredLeadTransition({stage:"NEW",revisionId:null},{leadId,previousRevisionId:null,toStage:"SIGNED"},policy())).toThrow("lead_pipeline_validation");const changed=policy();changed.transitions[0].to="QUALIFIED";expect(leadPipelinePolicySchema.safeParse(changed).success).toBe(false);
  });
  it("requires an explicit correction edge and retains the original revision",()=>{
    const value=policy(),revisionId=randomUUID(),input={leadId,previousRevisionId:revisionId,toStage:"NEW"};expect(()=>configuredLeadTransition({stage:"QUALIFIED",revisionId},input,value)).toThrow("lead_pipeline_validation");value.transitions.push({from:"QUALIFIED",to:"NEW",kind:"CORRECTION",evidence:[]});expect(configuredLeadTransition({stage:"QUALIFIED",revisionId},input,value).transition.kind).toBe("CORRECTION");expect(configuredLeadTransition({stage:"NEW",revisionId}, {leadId,previousRevisionId:revisionId,toStage:"CONTACTED"},value).input.previousRevisionId).toBe(revisionId);
  });
  it("rejects stale revisions, missing original history and no-op corrections",()=>{
    expect(()=>configuredLeadTransition({stage:"CONTACTED",revisionId:randomUUID()},{leadId,previousRevisionId:randomUUID(),toStage:"QUALIFIED"},policy())).toThrow("lead_pipeline_changed");expect(()=>configuredLeadTransition({stage:"CONTACTED",revisionId:null},{leadId,previousRevisionId:null,toStage:"QUALIFIED"},policy())).toThrow("lead_pipeline_changed");const value=policy();value.transitions.push({from:"NEW",to:"NEW",kind:"CORRECTION",evidence:[]});expect(leadPipelinePolicySchema.safeParse(value).success).toBe(false);
  });
  it.each(leadStages.slice(4))("cannot configure away native evidence for %s",to=>{
    const value=policy(),edge=value.transitions.find(row=>row.to===to)!;edge.evidence=[];expect(leadPipelinePolicySchema.safeParse(value).success).toBe(false);
  });
  it("requires explicit configured admission limits and append-only movement history",()=>{
    for(const changed of[{...policy(),admission:undefined},{...policy(),history:"EDITABLE_CURRENT_STATUS"},{...policy(),admission:{requests:0,window_seconds:60}},{...policy(),admission:{requests:10,window_seconds:0}}])expect(leadPipelinePolicySchema.safeParse(changed).success).toBe(false);
  });
  it("rejects duplicate edges, unsupported stages and duplicate proof requirements",()=>{
    const value=policy();for(const changed of[{...value,transitions:[value.transitions[0],value.transitions[0]]},{...value,transitions:[{...value.transitions[0],to:"LIVE"}]},{...value,transitions:[{...value.transitions[0],evidence:["PROPOSAL_VERSION","PROPOSAL_VERSION"]}]}])expect(leadPipelinePolicySchema.safeParse(changed).success).toBe(false);
  });
  it("canonicalizes UUIDs and Unicode reasons while rejecting caller-owned authority or proof claims",()=>{
    const input={leadId:leadId.toUpperCase(),previousRevisionId:null,toStage:"CONTACTED",idempotencyKey:randomUUID().toUpperCase(),reviewFingerprint:"a".repeat(64),reason:"  Évaluation documentée  "},parsed=leadStageCommandSchema.parse(input);expect(parsed.leadId).toBe(leadId);expect(parsed.reason).toBe("Évaluation documentée");
    for(const changed of[{...input,organizationId},{...input,actorId:randomUUID()},{...input,evidence:[proof("PROPOSAL_VERSION")]},{...input,fromStage:"NEW"},{...input,reason:""},{...input,reason:"unsafe\u0000reason"}])expect(leadStageCommandSchema.safeParse(changed).success).toBe(false);
  });
  it.each(leadPipelineEvidenceKinds)("requires the actual %s proof snapshot",kind=>{
    expect(()=>requireNativeLeadStageProofs(organizationId,leadId,[kind],[],now)).toThrow("lead_pipeline_native_evidence_required");expect(requireNativeLeadStageProofs(organizationId,leadId,[kind],[proof(kind)],now)).toHaveLength(1);
  });
  it("binds every proof to the exact tenant, lead, native time and immutable source fingerprint",()=>{
    const original=proof("CONTRACT_VERSION");for(const changed of[{...original,organizationId:randomUUID()},{...original,leadId:randomUUID()},{...original,occurredAt:"2031-01-01T00:00:00Z"}])expect(()=>requireNativeLeadStageProofs(organizationId,leadId,["CONTRACT_VERSION"],[changed],now)).toThrow("lead_pipeline_native_evidence_required");
    for(const changed of[{...original,sourceFingerprint:"claimed"},{...original,sourceId:"manual-claim"},{...original,observed:true}])expect(()=>requireNativeLeadStageProofs(organizationId,leadId,["CONTRACT_VERSION"],[changed],now)).toThrow();expect(()=>requireNativeLeadStageProofs(organizationId,leadId,[],[original,original],now)).toThrow("lead_pipeline_native_evidence_required");expect(()=>requireNativeLeadStageProofs(organizationId,leadId,[],[],new Date("invalid"))).toThrow("lead_pipeline_native_evidence_required");
  });
  it("canonically orders all native release proofs without mutating the caller snapshot",()=>{
    const snapshots=leadPipelineEvidenceKinds.map(proof).reverse(),before=structuredClone(snapshots),result=requireNativeLeadStageProofs(organizationId.toUpperCase(),leadId.toUpperCase(),leadPipelineEvidenceKinds,snapshots,now);expect(result.map(row=>row.kind)).toEqual(leadPipelineEvidenceKinds);expect(snapshots).toEqual(before);
  });
});
