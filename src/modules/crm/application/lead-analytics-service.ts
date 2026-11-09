import {randomUUID} from "node:crypto";
import {z,ZodError} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadAnalyticsRepository} from "../infrastructure/lead-analytics-repository";
import {LeadAccessError,LeadConfigurationError,LeadConflictError,LeadRateLimitError,LeadValidationError} from "../domain/lead-capture";
import {leadAnalyticsPolicyKey,leadAnalyticsPolicySchema,leadAnalyticsInputSchema,leadAnalyticsOptionsSchema,leadAnalyticsResultSchema,assertLeadAnalyticsRange,assembleLeadAnalytics,LeadAnalyticsRangeError} from "../domain/lead-analytics";
import type {LeadDependencies} from "./lead-capture-service";

const resource=(organizationId:string)=>({type:"lead",organizationId,dataClass:"operational"as const});
async function phase(actor:AccountActorContext,tx:TenantTransaction){
 const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new LeadRepository(tx,actor.organizationId).clock();
 assertAccountAuthorization(actor,stored,now,(["view","export"]as const).map(action=>({action,resource:resource(actor.organizationId),organizationOnly:true})),new LeadAccessError());
 return{now,cap:commandFingerprint({held:captureAuthorizationCap(actor.authContext),stored:captureAuthorizationCap(stored)})};
}
async function settings(tx:TenantTransaction,organizationId:string,now:Date){
 const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:leadAnalyticsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
 if(!rule?.createdBy)throw new LeadConfigurationError();const checked=leadAnalyticsPolicySchema.safeParse(rule.parsedValue);if(!checked.success)throw new LeadConfigurationError();
 return{rule,policy:checked.data,snapshot:{id:rule.id,version:rule.version,value:checked.data}};
}
export async function readLeadAnalyticsOptions(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 z.object({}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const first=await phase(actor,tx),configured=await settings(tx,actor.organizationId,first.now);
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_analytics_options_read",resourceType:"lead",resourceId:null,after:{policyId:configured.rule.id},requestId:deps.requestId??randomUUID(),occurredAt:first.now});
  const current=await settings(tx,actor.organizationId,await new LeadRepository(tx,actor.organizationId).clock()),final=await phase(actor,tx);
  if(first.cap!==final.cap||commandFingerprint(current.snapshot)!==commandFingerprint(configured.snapshot))throw new LeadConflictError();
  return leadAnalyticsOptionsSchema.parse({observedAt:final.now.toISOString(),maxRangeSeconds:configured.policy.max_range_seconds,maxSourceGroups:configured.policy.max_source_groups});
 });
}
export async function readLeadAnalytics(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=leadAnalyticsInputSchema.parse(raw),budget=await withTenant(deps.db,actor.organizationId,async tx=>{
  const first=await phase(actor,tx),configured=await settings(tx,actor.organizationId,first.now);assertLeadAnalyticsRange(input,configured.policy,first.now);
  const decision=await consumeRateLimit(tx,actor.organizationId,{key:"crm.lead_analytics:organization",limit:configured.policy.read_admission.requests,windowSeconds:configured.policy.read_admission.window_seconds,now:first.now});return{configured,decision};
 });if(!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const first=await phase(actor,tx),configured=await settings(tx,actor.organizationId,first.now);assertLeadAnalyticsRange(input,configured.policy,first.now);
  if(commandFingerprint(configured.snapshot)!==commandFingerprint(budget.configured.snapshot))throw new LeadConflictError();
  const repository=new LeadAnalyticsRepository(tx,actor.organizationId),rows=await repository.rows(input,first.now,configured.policy.max_source_groups);
  let result;try{result=assembleLeadAnalytics(rows,input,first.now,configured.policy.max_source_groups);}catch(error){if(error instanceof LeadAnalyticsRangeError)throw error;if(error instanceof ZodError||error instanceof LeadValidationError)throw new LeadConfigurationError();throw error;}
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_analytics_read",resourceType:"lead",resourceId:null,after:{filterFingerprint:commandFingerprint(input),policyId:configured.rule.id,observedAt:first.now.toISOString()},requestId:deps.requestId??randomUUID(),occurredAt:first.now});
  const freshRows=await repository.rows(input,first.now,configured.policy.max_source_groups),fresh=await settings(tx,actor.organizationId,await new LeadRepository(tx,actor.organizationId).clock()),final=await phase(actor,tx);
  if(first.cap!==final.cap||commandFingerprint(rows)!==commandFingerprint(freshRows)||commandFingerprint(configured.snapshot)!==commandFingerprint(fresh.snapshot))throw new LeadConflictError();
  const fields=Object.fromEntries(Object.keys(result).map(key=>[key,{dataClass:"operational"as const,requiredPermission:"lead:export"as const,mask:"omit"as const}]));
  return leadAnalyticsResultSchema.parse(present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...resource(actor.organizationId),data:result},fields,final.now));
 });
}
