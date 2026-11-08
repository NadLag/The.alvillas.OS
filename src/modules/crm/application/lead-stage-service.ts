import {randomUUID,createHash,timingSafeEqual} from "node:crypto";
import {z,ZodError} from "zod";
import type {Lead,LeadStageRevision} from "@prisma/client";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {LeadAccessError,LeadConfigurationError,LeadRateLimitError} from "../domain/lead-capture";
import {configuredLeadTransition,canonicalLeadStageDraft,canonicalLeadStageCommand,leadPipelinePolicyKey,leadPipelinePolicySchema,leadStageSchema,leadPipelineEvidenceKinds,LeadPipelineConflictError,type LeadStageDraft,type LeadStagePosition} from "../domain/lead-pipeline";
import {encryptLeadStageReason,decryptLeadStageReason} from "../domain/lead-stage-reason";
import {LeadStageRepository} from "../infrastructure/lead-stage-repository";
import {nativeLeadStageEvidence} from "./lead-stage-evidence";
import type {LeadDependencies} from "./lead-capture-service";

const protocol="ALVILLAS_NATIVE_LEAD_STAGE_V1",uuid=z.uuid().transform(value=>value.toLowerCase());
const historyInput=z.object({leadId:uuid,before:z.number().int().positive().optional()}).strict(),recoveryInput=z.object({idempotencyKey:uuid}).strict();
const resource=(lead:Lead,stage:string)=>({type:"lead",id:lead.id,organizationId:lead.organizationId,dataClass:"personal" as const,status:stage,occurredAt:lead.createdAt});
const reasonBinding=(row:LeadStageRevision)=>({organizationId:row.organizationId,leadId:row.leadId,revisionId:row.id,createdBy:row.createdBy,commandKey:row.commandKey});
const receipt=(row:LeadStageRevision,replayed:boolean)=>({id:row.id,leadId:row.leadId,number:row.number,fromStage:leadStageSchema.parse(row.fromStage),toStage:leadStageSchema.parse(row.toStage),createdAt:row.createdAt.toISOString(),replayed});
async function settings(tx:TenantTransaction,organizationId:string,now:Date){
  try{const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:leadPipelinePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if(!rule)throw new LeadConfigurationError();return{rule,policy:leadPipelinePolicySchema.parse(rule.parsedValue),snapshot:{id:rule.id,version:rule.version,value:rule.value}};}catch(error){if(error instanceof ZodError)throw new LeadConfigurationError();throw error;}
}
async function leadContext(actor:AccountActorContext,tx:TenantTransaction,leadId:string){
  const repository=new LeadStageRepository(tx,actor.organizationId),lead=await repository.lead(leadId);if(!lead)throw new LeadAccessError();const now=await repository.clock(),current=await repository.current(lead.id),position:LeadStagePosition={stage:current?leadStageSchema.parse(current.toStage):"NEW",revisionId:current?.id??null};
  await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource:resource(lead,position.stage)}],new LeadAccessError());return{repository,lead,now,current,position};
}
async function moveAuthority(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof leadContext>>,toStage:string){
  await recheckAccountAuthorization(actor,tx,await base.repository.clock(),[base.position.stage,toStage].flatMap(stage=>[{action:"view" as const,resource:resource(base.lead,stage)},{action:"edit" as const,resource:resource(base.lead,stage)}]),new LeadAccessError());
}
async function draftContext(actor:AccountActorContext,tx:TenantTransaction,input:LeadStageDraft,deps:LeadDependencies){
  const base=await leadContext(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,base.now),selected=configuredLeadTransition(base.position,input,configured.policy);await moveAuthority(actor,tx,base,input.toStage);
  const evidence=await nativeLeadStageEvidence(actor,tx,input,selected.transition.evidence,configured.policy,base.now,deps),reviewFingerprint=commandFingerprint({protocol,leadId:base.lead.id,position:base.position,input:canonicalLeadStageDraft(input),policy:configured.snapshot,evidence,authorizationCap:captureAuthorizationCap(actor.authContext)});
  return{...base,configured,selected,evidence,reviewFingerprint};
}
async function finalDraftFence(actor:AccountActorContext,tx:TenantTransaction,input:LeadStageDraft,base:Awaited<ReturnType<typeof draftContext>>,deps:LeadDependencies,recordedId?:string){
  const latest=await leadContext(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,latest.now);
  if(latest.position.revisionId!==(recordedId??base.position.revisionId)||(!recordedId&&latest.position.stage!==base.position.stage)||commandFingerprint(configured.snapshot)!==commandFingerprint(base.configured.snapshot))throw new LeadPipelineConflictError();
  await moveAuthority(actor,tx,base,input.toStage);const evidence=await nativeLeadStageEvidence(actor,tx,input,base.selected.transition.evidence,configured.policy,latest.now,deps);if(commandFingerprint(evidence)!==commandFingerprint(base.evidence))throw new LeadPipelineConflictError();
}
async function finalReadFence(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof leadContext>>){
  const fresh=await leadContext(actor,tx,base.lead.id);if(commandFingerprint(fresh.position)!==commandFingerprint(base.position))throw new LeadPipelineConflictError();return fresh;
}
function retainedCommand(row:LeadStageRevision,env?:NodeJS.ProcessEnv){
  const evidence=z.array(z.object({kind:z.enum(leadPipelineEvidenceKinds),sourceId:uuid}).passthrough()).parse(row.evidence);
  return canonicalLeadStageCommand({leadId:row.leadId,previousRevisionId:row.previousId,toStage:row.toStage,idempotencyKey:row.commandKey,reviewFingerprint:row.reviewFingerprint,reason:decryptLeadStageReason(row.reasonCipher,reasonBinding(row),env),evidenceReferences:evidence.map(proof=>({kind:proof.kind,sourceId:proof.sourceId}))});
}

export async function reviewLeadStage(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadStageDraft(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await draftContext(actor,tx,input,deps);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_stage_reviewed",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,fromStage:base.position.stage,toStage:input.toStage,policyId:base.configured.rule.id,reviewFingerprint:base.reviewFingerprint},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalDraftFence(actor,tx,input,base,deps);
    return{leadId:input.leadId,previousRevisionId:base.position.revisionId,fromStage:base.position.stage,toStage:input.toStage,kind:base.selected.transition.kind,requiredEvidence:base.selected.transition.evidence,reviewFingerprint:base.reviewFingerprint};
  });
}
export async function admitLeadStage(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadStageCommand(raw);
  const budget=await withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await leadContext(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,base.now),existing=await base.repository.byNonce(input.idempotencyKey);
    if(existing){if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();}else await moveAuthority(actor,tx,base,input.toStage);
    const decision=await consumeRateLimit(tx,actor.organizationId,{key:"crm.pipeline:organization",limit:configured.policy.admission.requests,windowSeconds:configured.policy.admission.window_seconds,now:base.now});return{configured,decision};
  });
  if(!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
  return withTenant(deps.db,actor.organizationId,async tx=>{
    const repository=new LeadStageRepository(tx,actor.organizationId);await new ConfigRuleRepository(tx,actor.organizationId).lockVersion(leadPipelinePolicyKey,"organization",null);await repository.lockLead(input.leadId);await repository.lockCommand(input.idempotencyKey);
    const existing=await repository.byNonce(input.idempotencyKey);
    if(existing){
      const base=await leadContext(actor,tx,input.leadId);if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();
      if(!timingSafeEqual(Buffer.from(commandFingerprint(retainedCommand(existing,deps.env)),"hex"),Buffer.from(commandFingerprint(input),"hex")))throw new LeadPipelineConflictError();
      await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_stage_recovered",resourceType:"lead",resourceId:existing.leadId,after:{leadId:existing.leadId,revisionId:existing.id,commandHash:existing.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalReadFence(actor,tx,base);return receipt(existing,true);
    }
    const draft:LeadStageDraft={leadId:input.leadId,previousRevisionId:input.previousRevisionId,toStage:input.toStage,evidenceReferences:input.evidenceReferences},base=await draftContext(actor,tx,draft,deps);
    if(commandFingerprint(base.configured.snapshot)!==commandFingerprint(budget.configured.snapshot)||input.reviewFingerprint!==base.reviewFingerprint)throw new LeadPipelineConflictError();
    const id=randomUUID(),reasonCipher=encryptLeadStageReason(input.reason,{organizationId:actor.organizationId,leadId:input.leadId,revisionId:id,createdBy:actor.actorId,commandKey:input.idempotencyKey},deps.env),reasonSha256=createHash("sha256").update(reasonCipher).digest("hex"),authorizationCap=captureAuthorizationCap(actor.authContext),commandHash=commandFingerprint({protocol,input:{...draft,idempotencyKey:input.idempotencyKey,reviewFingerprint:input.reviewFingerprint},reasonSha256,policy:base.configured.snapshot,evidence:base.evidence,authorizationCap});
    const row=await repository.create({id,leadId:input.leadId,previousId:base.position.revisionId,number:(base.current?.number??0)+1,fromStage:base.position.stage,toStage:input.toStage,kind:base.selected.transition.kind,createdBy:actor.actorId,createdAt:base.now,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,reasonCipher,reasonSha256,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,policySnapshot:base.configured.snapshot,authorizationCap,evidence:base.evidence,requestId:deps.requestId??randomUUID()});
    await new OutboxRepository(tx,actor.organizationId).append("crm.lead_stage_recorded",{leadId:row.leadId,revisionId:row.id,fromStage:row.fromStage,toStage:row.toStage},"crm.lead.stage:"+row.id,row.createdAt);
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_stage_recorded",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,revisionId:row.id,fromStage:row.fromStage,toStage:row.toStage,commandHash:row.commandHash,reasonSha256:row.reasonSha256,policyId:row.policyId},requestId:row.requestId,occurredAt:row.createdAt});await finalDraftFence(actor,tx,draft,base,deps,row.id);return receipt(row,false);
  });
}
export async function recoverLeadStage(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=recoveryInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const repository=new LeadStageRepository(tx,actor.organizationId),row=await repository.byNonce(input.idempotencyKey);if(!row)return{recorded:false,revision:null};if(row.createdBy!==actor.actorId)throw new LeadAccessError();const base=await leadContext(actor,tx,row.leadId);
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_stage_recovered",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,revisionId:row.id,commandHash:row.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalReadFence(actor,tx,base);return{recorded:true,revision:receipt(row,true)};
  });
}
export async function readLeadStageHistory(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=historyInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await leadContext(actor,tx,input.leadId),rows=await base.repository.history(input.leadId,input.before),stageHistory=rows.slice(0,20).map(row=>({...receipt(row,false),kind:row.kind,reason:decryptLeadStageReason(row.reasonCipher,reasonBinding(row),deps.env)}));
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_stage_history_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,count:stageHistory.length},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const final=await finalReadFence(actor,tx,base),data={leadId:input.leadId,stage:final.position.stage,revisionId:final.position.revisionId,stageHistory,next:rows.length>20?rows[19].number:null};
    return present({...actor.authContext,visibleDataClasses:new Set(["operational"] as const)},"view",{...resource(base.lead,final.position.stage),data},catalogFieldPolicy<typeof data>("lead"),final.now);
  });
}
