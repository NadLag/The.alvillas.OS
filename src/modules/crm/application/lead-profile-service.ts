import {LeadWorkRepository} from "../infrastructure/lead-work-repository";
import {leadResource} from "./lead-resource";
import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import {z,ZodError} from "zod";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadStageRepository} from "../infrastructure/lead-stage-repository";
import {LeadProfileRepository} from "../infrastructure/lead-profile-repository";
import {leadCaptureInputSchema,leadCapturePolicyKey,leadCapturePolicySchema,LeadAccessError,LeadConfigurationError,LeadRateLimitError} from "../domain/lead-capture";
import {leadProfilePolicyKey,leadProfilePolicySchema,canonicalLeadProfileDraft,canonicalLeadProfileCommand,configuredLeadProfile,LeadProfileConflictError,type LeadProfileDraft} from "../domain/lead-profile";
import {encryptLeadProfilePayload} from "../domain/lead-profile-payload";
import {decryptLeadPayload} from "../domain/lead-payload";
import {retainedLeadProfile,leadProfileReceipt} from "./lead-profile-snapshot";
import {leadCaptureBinding,type LeadDependencies} from "./lead-capture-service";

const uuid=z.uuid().transform(value=>value.toLowerCase()),recoverInput=z.object({idempotencyKey:uuid}).strict(),historyInput=z.object({leadId:uuid,before:z.number().int().positive().max(2147483646).optional()}).strict(),protocol="NATIVE_PRIVATE_LEAD_PROFILE_V1";
async function context(actor:AccountActorContext,tx:TenantTransaction,leadId:string){
  const leads=new LeadRepository(tx,actor.organizationId),lead=await leads.byId(leadId);if(!lead)throw new LeadAccessError();
  const repository=new LeadProfileRepository(tx,actor.organizationId),current=await repository.current(leadId),position=await new LeadStageRepository(tx,actor.organizationId).position(leadId),now=await leads.clock(),assignment=await new LeadWorkRepository(tx,actor.organizationId).currentAssignment(leadId),resource=leadResource(lead,position.stage,assignment);
  await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource}],new LeadAccessError());return{lead,repository,current,position,assignment,now,resource};
}
async function settings(tx:TenantTransaction,organizationId:string,now:Date){
  try{
    const config=new ConfigRuleRepository(tx,organizationId),scopes=[{scopeType:"organization" as const,scopeId:null}];
    const rule=await config.resolve({key:leadProfilePolicyKey,scopes,asOf:now}),capture=await config.resolve({key:leadCapturePolicyKey,scopes,asOf:now});if(!rule||!capture)throw new LeadConfigurationError();
    return{rule,capture,policy:leadProfilePolicySchema.parse(rule.parsedValue),capturePolicy:leadCapturePolicySchema.parse(capture.parsedValue),snapshot:{id:rule.id,version:rule.version,value:rule.value},captureSnapshot:{id:capture.id,version:capture.version,value:capture.value}};
  }catch(error){if(error instanceof ZodError)throw new LeadConfigurationError();throw error;}
}
async function editable(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof context>>){
  await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),[{action:"view",resource:base.resource},{action:"edit",resource:base.resource}],new LeadAccessError());
}
async function reviewed(actor:AccountActorContext,tx:TenantTransaction,input:LeadProfileDraft){
  const base=await context(actor,tx,input.leadId);await editable(actor,tx,base);if((base.current?.id??null)!==input.previousRevisionId)throw new LeadProfileConflictError();
  const configured=await settings(tx,actor.organizationId,base.now);configuredLeadProfile(input,leadCaptureInputSchema.shape.channel.parse(base.lead.channel),configured.capturePolicy);
  const reviewFingerprint=commandFingerprint({protocol,input:canonicalLeadProfileDraft(input),originalCapture:base.lead.payloadSha256,profileRevisionId:base.current?.id??null,position:base.position,assignmentRevisionId:base.assignment?.id??null,policy:configured.snapshot,capturePolicy:configured.captureSnapshot,authorizationCap:captureAuthorizationCap(actor.authContext)});
  return{...base,configured,reviewFingerprint};
}
async function finalRead(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof context>>){
  const fresh=await context(actor,tx,base.lead.id);if((fresh.current?.id??null)!==(base.current?.id??null)||commandFingerprint(fresh.position)!==commandFingerprint(base.position)||(fresh.assignment?.id??null)!==(base.assignment?.id??null))throw new LeadProfileConflictError();return fresh;
}
async function finalWrite(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof reviewed>>,recordedId?:string){
  const fresh=await context(actor,tx,base.lead.id),configured=await settings(tx,actor.organizationId,fresh.now);
  if((fresh.current?.id??null)!==(recordedId??base.current?.id??null)||commandFingerprint(fresh.position)!==commandFingerprint(base.position)||(fresh.assignment?.id??null)!==(base.assignment?.id??null)||commandFingerprint(configured.snapshot)!==commandFingerprint(base.configured.snapshot)||commandFingerprint(configured.captureSnapshot)!==commandFingerprint(base.configured.captureSnapshot))throw new LeadProfileConflictError();
  await editable(actor,tx,fresh);
}
export async function reviewLeadProfile(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadProfileDraft(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await reviewed(actor,tx,input);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_profile_reviewed",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,previousRevisionId:input.previousRevisionId,reviewFingerprint:base.reviewFingerprint,policyId:base.configured.rule.id,capturePolicyId:base.configured.capture.id},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalWrite(actor,tx,base);
    return{leadId:input.leadId,previousRevisionId:input.previousRevisionId,reviewFingerprint:base.reviewFingerprint};
  });
}
export async function admitLeadProfile(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadProfileCommand(raw),draft=canonicalLeadProfileDraft({leadId:input.leadId,previousRevisionId:input.previousRevisionId,sourceKey:input.sourceKey,locale:input.locale,fields:input.fields});
  const budget=await withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await context(actor,tx,input.leadId),existing=await base.repository.byNonce(input.idempotencyKey),configured=await settings(tx,actor.organizationId,base.now);
    if(existing){if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();}else await editable(actor,tx,base);
    return{configured,decision:await consumeRateLimit(tx,actor.organizationId,{key:"crm.lead_profile:organization",limit:configured.policy.admission.requests,windowSeconds:configured.policy.admission.window_seconds,now:base.now})};
  });if(!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
  return withTenant(deps.db,actor.organizationId,async tx=>{
    const config=new ConfigRuleRepository(tx,actor.organizationId);await config.lockVersion(leadCapturePolicyKey,"organization",null);await config.lockVersion(leadProfilePolicyKey,"organization",null);
    const repository=new LeadProfileRepository(tx,actor.organizationId);await repository.lockLead(input.leadId);await repository.lockCommand(input.idempotencyKey);const existing=await repository.byNonce(input.idempotencyKey);
    if(existing){
      const base=await context(actor,tx,input.leadId);if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();
      if(!timingSafeEqual(Buffer.from(commandFingerprint(retainedLeadProfile(existing,deps.env)),"hex"),Buffer.from(commandFingerprint(input),"hex")))throw new LeadProfileConflictError();
      await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_profile_recovered",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,revisionId:existing.id,commandHash:existing.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalRead(actor,tx,base);return leadProfileReceipt(existing,true);
    }
    const base=await reviewed(actor,tx,draft);if(base.reviewFingerprint!==input.reviewFingerprint||commandFingerprint(base.configured.snapshot)!==commandFingerprint(budget.configured.snapshot)||commandFingerprint(base.configured.captureSnapshot)!==commandFingerprint(budget.configured.captureSnapshot)||(base.current?.number??0)>=2147483646)throw new LeadProfileConflictError();
    const id=randomUUID(),authorizationCap=captureAuthorizationCap(actor.authContext),encryptedPayload=encryptLeadProfilePayload(input,{organizationId:actor.organizationId,leadId:input.leadId,revisionId:id,previousRevisionId:input.previousRevisionId,createdBy:actor.actorId,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,capturePolicyId:base.configured.capture.id,capturePolicyVersion:base.configured.capture.version,commandKey:input.idempotencyKey},deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),commandHash=commandFingerprint({protocol,input,payloadSha256,authorizationCap});
    const row=await repository.create({id,leadId:input.leadId,previousId:input.previousRevisionId,number:(base.current?.number??0)+1,sourceKey:input.sourceKey,locale:input.locale,createdBy:actor.actorId,createdAt:base.now,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,payloadSchemaVersion:1,encryptedPayload,payloadSha256,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,policySnapshot:base.configured.snapshot,capturePolicyId:base.configured.capture.id,capturePolicyVersion:base.configured.capture.version,capturePolicySnapshot:base.configured.captureSnapshot,authorizationCap,requestId:deps.requestId??randomUUID()});
    await new OutboxRepository(tx,actor.organizationId).append("crm.lead_profile_recorded",{leadId:row.leadId,revisionId:row.id,number:row.number},"crm.lead.profile.recorded:"+row.id,row.createdAt);
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_profile_recorded",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,revisionId:row.id,number:row.number,previousRevisionId:row.previousId,sourceKey:row.sourceKey,locale:row.locale,commandHash:row.commandHash,payloadSha256:row.payloadSha256,policyId:row.policyId,capturePolicyId:row.capturePolicyId,reviewFingerprint:row.reviewFingerprint},requestId:row.requestId,occurredAt:row.createdAt});await finalWrite(actor,tx,base,row.id);return leadProfileReceipt(row,false);
  });
}
export async function recoverLeadProfile(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=recoverInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const row=await new LeadProfileRepository(tx,actor.organizationId).byNonce(input.idempotencyKey);if(!row)return{recorded:false,revision:null};if(row.createdBy!==actor.actorId)throw new LeadAccessError();const base=await context(actor,tx,row.leadId);
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_profile_recovered",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,revisionId:row.id,commandHash:row.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalRead(actor,tx,base);return{recorded:true,revision:leadProfileReceipt(row,true)};
  });
}
export async function readLeadProfileHistory(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=historyInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await context(actor,tx,input.leadId),rows=await base.repository.history(input.leadId,input.before),profileHistory=rows.slice(0,20).map(row=>{const payload=retainedLeadProfile(row,deps.env);return{...leadProfileReceipt(row,false),fields:payload.fields,reason:payload.reason};}),original={id:base.lead.id,sourceKey:base.lead.sourceKey,locale:base.lead.locale,createdAt:base.lead.createdAt.toISOString(),fields:decryptLeadPayload(base.lead.encryptedPayload,leadCaptureBinding(base.lead),deps.env).fields};
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_profile_history_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,count:profileHistory.length,before:input.before??null},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await finalRead(actor,tx,base),data={leadId:input.leadId,profileRevisionId:base.current?.id??null,original,profileHistory,next:rows.length>20?rows[19].number:null};
    return present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...fresh.resource,data},catalogFieldPolicy<typeof data>("lead"),fresh.now);
  });
}
