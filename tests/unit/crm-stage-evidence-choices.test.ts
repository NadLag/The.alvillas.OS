import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {leadStageEvidenceChoicesInputSchema,leadStageEvidenceChoicesSchema,leadStageEvidencePrefix} from "@/modules/crm/domain/lead-stage-evidence-choices";
import {leadPipelineEvidenceKinds,LeadPipelineEvidenceError} from "@/modules/crm/domain/lead-pipeline";

const leadId=randomUUID(),previousRevisionId=randomUUID(),proposal={kind:"PROPOSAL_VERSION"as const,sourceId:randomUUID()},contract={kind:"CONTRACT_VERSION"as const,sourceId:randomUUID()},draft={leadId,previousRevisionId,toStage:"CONTRACT_DRAFT"as const,evidenceReferences:[proposal]};
const result=()=>({protocol:"NATIVE_LEAD_STAGE_EVIDENCE_CHOICES_V1"as const,leadId,previousRevisionId,toStage:"CONTRACT_DRAFT"as const,required:["PROPOSAL_VERSION","CONTRACT_VERSION"],selected:[proposal],nextKind:"CONTRACT_VERSION",items:[{kind:"DOCUMENT",id:randomUUID(),title:"Approved actual contract",locale:"fr"}],next:null,dependency:null});
describe("native stage evidence selection protocol",()=>{
 it("walks the configured edge in native dependency order without choosing an arbitrary document",()=>{const value=leadStageEvidencePrefix(["CONTRACT_VERSION","PROPOSAL_VERSION"],draft);expect(value).toEqual({required:["PROPOSAL_VERSION","CONTRACT_VERSION"],selected:[proposal],nextKind:"CONTRACT_VERSION"});expect(leadStageEvidenceChoicesSchema.parse(result()).items[0]).toMatchObject({kind:"DOCUMENT",title:"Approved actual contract"});});
 it.each([{references:[contract]},{references:[proposal,proposal]},{references:[{kind:"OWNER_CONVERSION"as const,sourceId:randomUUID()}]},{references:[proposal,contract,{kind:"SIGNATURE_SENT"as const,sourceId:randomUUID()}]}])("rejects a skipped, duplicated, foreign or excessive proof prefix %j",({references})=>{expect(()=>leadStageEvidencePrefix(["PROPOSAL_VERSION","CONTRACT_VERSION"],{...draft,evidenceReferences:references})).toThrow(LeadPipelineEvidenceError);});
 it.each(["complete","signed","providerEvidence","ownerId","financialAccepted"])("rejects caller completion assertions and substituted resource fields: %s",key=>{expect(leadStageEvidenceChoicesInputSchema.safeParse({...draft,[key]:true}).success).toBe(false);});
 it("keeps document and signature catalogs distinct and validates actual identifiers",()=>{expect(leadStageEvidenceChoicesInputSchema.safeParse({...draft,documentId:randomUUID(),signatureId:randomUUID()}).success).toBe(false);expect(leadStageEvidenceChoicesInputSchema.safeParse({...draft,documentId:"not-a-native-record"}).success).toBe(false);expect(leadStageEvidenceChoicesInputSchema.parse({...draft,documentId:randomUUID()})).toMatchObject(draft);});
 it("allows a correction with no evidence while refusing a fake completed catalog",()=>{expect(leadStageEvidencePrefix([],{...draft,evidenceReferences:[]})).toEqual({required:[],selected:[],nextKind:null});expect(leadStageEvidenceChoicesSchema.safeParse({...result(),required:[],selected:[],nextKind:null}).success).toBe(false);});
 it.each([
  {required:["CONTRACT_VERSION","PROPOSAL_VERSION"]},{required:["PROPOSAL_VERSION","PROPOSAL_VERSION"]},{selected:[contract]},{nextKind:"SIGNATURE_SENT"},
  {items:[{kind:"EVIDENCE",id:randomUUID(),evidenceKind:"OWNER_CONVERSION",occurredAt:"2026-11-08T00:00:00.000Z"}]},
  {items:[{kind:"SIGNATURE",id:randomUUID(),state:"SIGNED",createdAt:"2026-11-08T00:00:00.000Z"}]},{dependency:"F-ONB-07"}
 ])("rejects an inconsistent response that could relabel or bypass the next proof %j",change=>{expect(leadStageEvidenceChoicesSchema.safeParse({...result(),...change}).success).toBe(false);});
 it("keeps Go Live closed at the actual onboarding release dependency",()=>{const selected=leadPipelineEvidenceKinds.slice(0,-1).map(kind=>({kind,sourceId:randomUUID()}));expect(leadStageEvidenceChoicesSchema.parse({...result(),toStage:"GO_LIVE",required:[...leadPipelineEvidenceKinds],selected,nextKind:"ONBOARDING_RELEASE",items:[],dependency:"F-ONB-07"}).dependency).toBe("F-ONB-07");});
});
