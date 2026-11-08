import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import {z,ZodError} from "zod";
import type {Lead} from "@prisma/client";
import {withTenant,assertOrganizationId,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {LeadRepository} from "../infrastructure/lead-repository";
import {leadCaptureInputSchema,leadCapturePolicyKey,leadCapturePolicySchema,leadCaptureMaximumRequestBytes,parseConfiguredLeadCapture,
  LeadAccessError,LeadConfigurationError,LeadConflictError,LeadValidationError,LeadRateLimitError} from "../domain/lead-capture";
import {encryptLeadPayload,decryptLeadPayload,type LeadPayloadBinding} from "../domain/lead-payload";

export type LeadDependencies={db:TenantTransactionRunner;requestId?:string;env?:NodeJS.ProcessEnv};
const referenceSchema=z.object({leadId:z.uuid().transform(value=>value.toLowerCase())}).strict();
const receiptSchema=z.object({id:z.uuid(),initialStage:z.literal("NEW"),channel:leadCaptureInputSchema.shape.channel,
  sourceKey:leadCaptureInputSchema.shape.sourceKey,locale:leadCaptureInputSchema.shape.locale,createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
const resource=(organizationId:string,id:string,at:Date)=>({type:"lead",id,organizationId,dataClass:"personal" as const,status:"NEW",occurredAt:at});
function binding(row:Lead):LeadPayloadBinding{
  if(row.payloadSchemaVersion!==1)throw new LeadConfigurationError();
  return{organizationId:row.organizationId,leadId:row.id,createdBy:row.createdBy,policyId:row.policyId,policyVersion:row.policyVersion,
    channel:leadCaptureInputSchema.shape.channel.parse(row.channel),sourceKey:row.sourceKey,idempotencyKey:row.commandKey};
}
const receipt=(row:Lead,replayed:boolean)=>receiptSchema.parse({id:row.id,initialStage:row.initialStage,channel:row.channel,sourceKey:row.sourceKey,locale:row.locale,createdAt:row.createdAt.toISOString(),replayed});

async function settings(tx:TenantTransaction,organizationId:string,now:Date){
  try{
    const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:leadCapturePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
    if(!rule?.createdBy)throw new LeadConfigurationError();
    return{rule,policy:leadCapturePolicySchema.parse(rule.parsedValue),snapshot:{id:rule.id,version:rule.version,value:rule.value}};
  }catch(error){if(error instanceof ZodError)throw new LeadConfigurationError();throw error;}
}
type Settings=Awaited<ReturnType<typeof settings>>;
async function captureAuthority(actor:AccountActorContext,tx:TenantTransaction,now:Date,target:ReturnType<typeof resource>,website:boolean){
  await recheckAccountAuthorization(actor,tx,now,[{action:"create",resource:target,...website?{organizationOnly:true}:{}},
    ...website?[{action:"configure" as const,resource:{type:"config_rule",organizationId:actor.organizationId},organizationOnly:true}]:[]],new LeadAccessError());
}
function parsedInput(raw:unknown){const input=leadCaptureInputSchema.parse(raw);if(new TextEncoder().encode(JSON.stringify(input)).byteLength>leadCaptureMaximumRequestBytes)throw new LeadValidationError();return input;}
async function finalCaptureFence(actor:AccountActorContext,tx:TenantTransaction,row:Lead,expected:Settings,website:boolean){
  const now=await new LeadRepository(tx,actor.organizationId).clock(),current=await settings(tx,actor.organizationId,now);
  if(commandFingerprint(current.snapshot)!==commandFingerprint(expected.snapshot)||(website&&current.rule.createdBy!==actor.actorId))throw new LeadConflictError();
  await captureAuthority(actor,tx,now,resource(actor.organizationId,row.id,row.createdAt),website);
}

async function capture(organizationInput:string,raw:unknown,actor:AccountActorContext|null,deps:LeadDependencies){
  assertOrganizationId(organizationInput);const organizationId=organizationInput.toLowerCase();
  const input=parsedInput(raw),website=actor===null;
  if(website?input.channel!=="WEBSITE":input.channel==="WEBSITE")throw new LeadValidationError();
  if(actor&&(actor.organizationId!==organizationId||actor.actorId!==actor.authContext.userAccountId||actor.authContext.organizationId!==organizationId))throw new LeadAccessError();
  const candidateId=randomUUID();
  // Commit the configured organization budget even when the resulting decision denies admission.
  const budget=await withTenant(deps.db,organizationId,async tx=>{
    const repository=new LeadRepository(tx,organizationId),now=await repository.clock(),configured=await settings(tx,organizationId,now),principalId=configured.rule.createdBy!;
    const caller=actor??{organizationId,actorId:principalId,authContext:await authContextForAccountInTransaction(tx,organizationId,principalId)};
    const original=await repository.byNonce(input.idempotencyKey);
    await captureAuthority(caller,tx,now,resource(organizationId,original?.id??candidateId,original?.createdAt??now),website);
    if(original&&original.createdBy!==caller.actorId)throw new LeadConflictError();
    const decision=await consumeRateLimit(tx,organizationId,{key:"crm.lead_capture:organization",limit:configured.policy.rate_limit.requests,windowSeconds:configured.policy.rate_limit.window_seconds,now});
    return{caller,configured,decision};
  });
  if(!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
  return withTenant(deps.db,organizationId,async tx=>{
    const rules=new ConfigRuleRepository(tx,organizationId),repository=new LeadRepository(tx,organizationId);
    await rules.lockVersion(leadCapturePolicyKey,"organization",null);await repository.lockCommand(input.idempotencyKey);
    const now=await repository.clock(),configured=await settings(tx,organizationId,now),caller=budget.caller;
    if(commandFingerprint(configured.snapshot)!==commandFingerprint(budget.configured.snapshot)||(website&&configured.rule.createdBy!==caller.actorId))throw new LeadConflictError();
    const original=await repository.byNonce(input.idempotencyKey);
    await captureAuthority(caller,tx,now,resource(organizationId,original?.id??candidateId,original?.createdAt??now),website);
    const requestId=deps.requestId??randomUUID();
    if(original){
      if(original.createdBy!==caller.actorId)throw new LeadConflictError();
      const retained=decryptLeadPayload(original.encryptedPayload,binding(original),deps.env);
      if(!timingSafeEqual(Buffer.from(commandFingerprint(retained),"hex"),Buffer.from(commandFingerprint(input),"hex")))throw new LeadConflictError();
      await writeAuditEvent(tx,{organizationId,actorId:website?null:caller.actorId,action:"crm.lead_recovered",resourceType:"lead",resourceId:original.id,
        after:{principalId:caller.actorId,leadId:original.id,channel:original.channel,commandHash:original.commandHash},requestId,occurredAt:now});
      await finalCaptureFence(caller,tx,original,configured,website);return receipt(original,true);
    }
    const value=parseConfiguredLeadCapture(input,configured.policy),identity:LeadPayloadBinding={organizationId,leadId:candidateId,createdBy:caller.actorId,policyId:configured.rule.id,policyVersion:configured.rule.version,channel:value.channel,sourceKey:value.sourceKey,idempotencyKey:value.idempotencyKey};
    const encryptedPayload=encryptLeadPayload(value,identity,deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),authorizationCap=captureAuthorizationCap(caller.authContext);
    const commandHash=commandFingerprint({protocol:"ALVILLAS_LEAD_CAPTURE_V1",...identity,locale:value.locale,payloadSha256});
    const row=await repository.create({id:candidateId,createdBy:caller.actorId,createdAt:now,initialStage:"NEW",channel:value.channel,sourceKey:value.sourceKey,locale:value.locale,
      commandKey:value.idempotencyKey,commandHash,encryptedPayload,payloadSha256,policyId:configured.rule.id,policyVersion:configured.rule.version,policySnapshot:configured.snapshot,
      authorizationCap,requestId});
    await new OutboxRepository(tx,organizationId).append("crm.lead_captured",{leadId:row.id,channel:row.channel,sourceKey:row.sourceKey},"crm.lead.captured:"+row.id,now);
    await writeAuditEvent(tx,{organizationId,actorId:website?null:caller.actorId,action:"crm.lead_captured",resourceType:"lead",resourceId:row.id,
      after:{principalId:caller.actorId,leadId:row.id,channel:row.channel,sourceKey:row.sourceKey,commandHash,payloadSha256,policyId:row.policyId},requestId,occurredAt:now});
    await finalCaptureFence(caller,tx,row,configured,website);return receipt(row,false);
  });
}

export function captureLead(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){return capture(actor.organizationId,raw,actor,deps);}
export function captureWebsiteLead(organizationId:string,raw:unknown,deps:LeadDependencies){return capture(organizationId,raw,null,deps);}

/** Public routing selects this trusted server binding; intake payloads never select a tenant. */
export function configuredWebsiteLeadOrganization(env:NodeJS.ProcessEnv=process.env):string{
  const value=env.ALVILLAS_PUBLIC_ORGANIZATION_ID;
  if(!value)throw new LeadConfigurationError();try{assertOrganizationId(value);}catch{throw new LeadConfigurationError();}return value.toLowerCase();
}

export async function readLead(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=referenceSchema.parse(raw);
  return withTenant(deps.db,actor.organizationId,async tx=>{
    const repository=new LeadRepository(tx,actor.organizationId),row=await repository.byId(input.leadId);if(!row)throw new LeadAccessError();
    const target=resource(actor.organizationId,row.id,row.createdAt),now=await repository.clock();
    await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource:target}],new LeadAccessError());
    const payload=decryptLeadPayload(row.encryptedPayload,binding(row),deps.env),data={...receipt(row,false),fields:payload.fields};
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_read",resourceType:"lead",resourceId:row.id,
      after:{leadId:row.id,channel:row.channel,commandHash:row.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:now});
    const finalNow=await repository.clock();await recheckAccountAuthorization(actor,tx,finalNow,[{action:"view",resource:target}],new LeadAccessError());
    return present({...actor.authContext,visibleDataClasses:new Set(["operational"] as const)},"view",{...target,data},catalogFieldPolicy<typeof data>("lead"),finalNow);
  });
}
