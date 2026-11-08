import {randomUUID,createHash,timingSafeEqual} from "node:crypto";
import {z,ZodError} from "zod";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authorize} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction,authContextsForAccountsInTransaction} from "@/platform/authz/account-context";
import {recheckAccountAuthorization,assertAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadProfileRepository} from "../infrastructure/lead-profile-repository";
import {LeadStageRepository} from "../infrastructure/lead-stage-repository";
import {LeadWorkRepository} from "../infrastructure/lead-work-repository";
import {leadCapturePolicyKey,leadCapturePolicySchema,LeadAccessError,LeadConfigurationError,LeadRateLimitError} from "../domain/lead-capture";
import {canonicalLeadWorkDraft,canonicalLeadWorkCommand,leadWorkDraftFromCommand,configuredLeadWorkDraft,requireConfiguredLeadWorkSubject,leadWorkPolicyKey,leadWorkPolicySchema,LeadWorkConflictError,type LeadWorkDraft} from "../domain/lead-work";
import {encryptLeadWorkPayload} from "../domain/lead-work-payload";
import {leadWorkReceipt,leadWorkSubject,retainedLeadWork,leadWorkHistoryItem} from "./lead-work-snapshot";
import {leadResource} from "./lead-resource";
import type {LeadDependencies} from "./lead-capture-service";
import {leadWorkOptionsSchema,leadWorkCandidatesSchema} from "../domain/lead-work-view";

const protocol="NATIVE_PRIVATE_LEAD_WORK_V1",uuid=z.uuid().transform(v=>v.toLowerCase()),recoveryInput=z.object({idempotencyKey:uuid}).strict(),historyInput=z.object({leadId:uuid,before:z.number().int().positive().max(2147483646).optional()}).strict();
async function context(actor:AccountActorContext,tx:TenantTransaction,leadId:string){
  const leads=new LeadRepository(tx,actor.organizationId),lead=await leads.byId(leadId);if(!lead)throw new LeadAccessError();
  const repository=new LeadWorkRepository(tx,actor.organizationId),current=await repository.current(leadId),assignment=await repository.currentAssignment(leadId),profile=await new LeadProfileRepository(tx,actor.organizationId).current(leadId),stage=await new LeadStageRepository(tx,actor.organizationId).current(leadId),now=await leads.clock(),resource=leadResource(lead,stage?.toStage??lead.initialStage,assignment);
  await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource}],new LeadAccessError());
  return{lead,repository,current,assignment,profile,stage,now,resource,position:{payloadSha256:lead.payloadSha256,profileId:profile?.id??null,stageId:stage?.id??null,assignmentId:assignment?.id??null,workId:current?.id??null}};
}
async function settings(tx:TenantTransaction,organizationId:string,now:Date){
  try{const config=new ConfigRuleRepository(tx,organizationId),scopes=[{scopeType:"organization" as const,scopeId:null}],rule=await config.resolve({key:leadWorkPolicyKey,scopes,asOf:now}),capture=await config.resolve({key:leadCapturePolicyKey,scopes,asOf:now});if(!rule||!capture)throw new LeadConfigurationError();return{rule,capture,policy:leadWorkPolicySchema.parse(rule.parsedValue),capturePolicy:leadCapturePolicySchema.parse(capture.parsedValue),snapshot:{id:rule.id,version:rule.version,value:rule.value},captureSnapshot:{id:capture.id,version:capture.version,value:capture.value}};}catch(error){if(error instanceof ZodError)throw new LeadConfigurationError();throw error;}
}
async function editable(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof context>>,kind:LeadWorkDraft["kind"]){
  await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),[{action:"view",resource:base.resource},{action:kind==="ASSIGNMENT"?"assign":"edit",resource:base.resource}],new LeadAccessError());
}
async function accountSource(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof context>>,input:LeadWorkDraft){
  if(input.kind==="REMINDER"&&input.state!=="OPEN")return null;
  const id=input.kind==="REMINDER"?input.recipientId:input.kind==="ASSIGNMENT"?input.representativeId:null;if(id===null)return null;
  const account=await base.repository.account(id);if(!account)throw new LeadAccessError();
  if(id!==actor.actorId)await recheckAccountAuthorization(actor,tx,base.now,[{action:"view",resource:{type:"team_member",id:account.personId,organizationId:actor.organizationId,dataClass:"personal"}}],new LeadAccessError());
  const authority={...await authContextForAccountInTransaction(tx,actor.organizationId,id),personId:account.personId},resource=input.kind==="ASSIGNMENT"?leadResource(base.lead,base.resource.status,{representativeId:account.id,representativePersonId:account.personId}):base.resource;
  if(!authorize(authority,"view",resource,base.now))throw new LeadAccessError();return{account,cap:captureAuthorizationCap(authority)};
}
async function reviewed(actor:AccountActorContext,tx:TenantTransaction,input:LeadWorkDraft,deps:LeadDependencies){
  const base=await context(actor,tx,input.leadId);await editable(actor,tx,base,input.kind);if((base.current?.id??null)!==input.previousRevisionId)throw new LeadWorkConflictError();
  const configured=await settings(tx,actor.organizationId,base.now);configuredLeadWorkDraft(input,configured.policy,base.now);
  const subject=input.subjectId?await base.repository.subject(input.leadId,input.subjectId):input.kind==="ASSIGNMENT"?base.assignment:null;requireConfiguredLeadWorkSubject(input,subject?leadWorkSubject(subject,deps.env):null,configured.policy);
  const selected=await accountSource(actor,tx,base,input),reviewFingerprint=commandFingerprint({protocol,input:canonicalLeadWorkDraft(input),position:base.position,subjectRevisionId:subject?.id??null,policy:configured.snapshot,capturePolicy:configured.captureSnapshot,selected:selected?{accountId:selected.account.id,personId:selected.account.personId,authorizationCap:selected.cap}:null,authorizationCap:captureAuthorizationCap(actor.authContext)});
  return{...base,configured,subject,selected,reviewFingerprint};
}
async function finalRead(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof context>>){const fresh=await context(actor,tx,base.lead.id);if(commandFingerprint(fresh.position)!==commandFingerprint(base.position))throw new LeadWorkConflictError();return fresh;}
async function finalWrite(actor:AccountActorContext,tx:TenantTransaction,input:LeadWorkDraft,base:Awaited<ReturnType<typeof reviewed>>,recordedId?:string){
  const fresh=await context(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,fresh.now),expected={...base.position,workId:recordedId??base.position.workId,assignmentId:recordedId&&input.kind==="ASSIGNMENT"?recordedId:base.position.assignmentId};
  if(commandFingerprint(fresh.position)!==commandFingerprint(expected)||commandFingerprint(configured.snapshot)!==commandFingerprint(base.configured.snapshot)||commandFingerprint(configured.captureSnapshot)!==commandFingerprint(base.configured.captureSnapshot))throw new LeadWorkConflictError();
  configuredLeadWorkDraft(input,configured.policy,fresh.now);await editable(actor,tx,fresh,input.kind);await editable(actor,tx,base,input.kind);
  const selected=await accountSource(actor,tx,fresh,input);if(commandFingerprint(selected?{id:selected.account.id,personId:selected.account.personId,cap:selected.cap}:null)!==commandFingerprint(base.selected?{id:base.selected.account.id,personId:base.selected.account.personId,cap:base.selected.cap}:null))throw new LeadWorkConflictError();
}
export async function reviewLeadWork(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadWorkDraft(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const base=await reviewed(actor,tx,input,deps);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_reviewed",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,kind:input.kind,previousRevisionId:input.previousRevisionId,subjectId:input.subjectId,previousSubjectRevisionId:input.previousSubjectRevisionId,reviewFingerprint:base.reviewFingerprint,policyId:base.configured.rule.id},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalWrite(actor,tx,input,base);return{leadId:input.leadId,kind:input.kind,previousRevisionId:input.previousRevisionId,subjectId:input.subjectId,previousSubjectRevisionId:input.previousSubjectRevisionId,reviewFingerprint:base.reviewFingerprint};});
}
export async function admitLeadWork(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=canonicalLeadWorkCommand(raw),draft=leadWorkDraftFromCommand(input),budget=await withTenant(deps.db,actor.organizationId,async tx=>{const base=await context(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,base.now),existing=await base.repository.byNonce(input.idempotencyKey);if(existing){if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();}else await editable(actor,tx,base,input.kind);return{configured,decision:await consumeRateLimit(tx,actor.organizationId,{key:"crm.lead_work:organization",limit:configured.policy.admission.requests,windowSeconds:configured.policy.admission.window_seconds,now:base.now})};});
  if(!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
  return withTenant(deps.db,actor.organizationId,async tx=>{
    const config=new ConfigRuleRepository(tx,actor.organizationId);await config.lockVersion(leadCapturePolicyKey,"organization",null);await config.lockVersion(leadWorkPolicyKey,"organization",null);const repository=new LeadWorkRepository(tx,actor.organizationId);await repository.lockLead(input.leadId);await repository.lockCommand(input.idempotencyKey);const existing=await repository.byNonce(input.idempotencyKey);
    if(existing){const base=await context(actor,tx,input.leadId);if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();if(!timingSafeEqual(Buffer.from(commandFingerprint(retainedLeadWork(existing,deps.env)),"hex"),Buffer.from(commandFingerprint(input),"hex")))throw new LeadWorkConflictError();await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_recovered",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,entryId:existing.id,commandHash:existing.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalRead(actor,tx,base);return leadWorkReceipt(existing,true);}
    const base=await reviewed(actor,tx,draft,deps);if(input.reviewFingerprint!==base.reviewFingerprint||commandFingerprint(base.configured.snapshot)!==commandFingerprint(budget.configured.snapshot)||commandFingerprint(base.configured.captureSnapshot)!==commandFingerprint(budget.configured.captureSnapshot))throw new LeadWorkConflictError();
    const identity=await repository.identity(),id=identity.id,subjectId=base.subject?.subjectId??id,subjectNumber=(base.subject?.subjectNumber??0)+1,authorizationCap=captureAuthorizationCap(actor.authContext),encryptedPayload=encryptLeadWorkPayload(input,{organizationId:actor.organizationId,leadId:input.leadId,revisionId:id,previousRevisionId:input.previousRevisionId,subjectId,previousSubjectRevisionId:input.previousSubjectRevisionId,kind:input.kind,createdBy:actor.actorId,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,capturePolicyId:base.configured.capture.id,capturePolicyVersion:base.configured.capture.version,commandKey:input.idempotencyKey},deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),commandHash=commandFingerprint({protocol,input,payloadSha256,authorizationCap});
    const row=await repository.create({id,leadId:input.leadId,previousId:input.previousRevisionId,number:(base.current?.number??0)+1,subjectId,previousSubjectId:input.previousSubjectRevisionId,subjectNumber,kind:input.kind,activityTypeKey:input.kind==="ACTIVITY"?input.activityTypeKey:null,occurredAt:input.kind==="ACTIVITY"?new Date(input.occurredAt):null,reminderState:input.kind==="REMINDER"?input.state:null,dueAt:input.kind==="REMINDER"?new Date(input.dueAt):null,recipientId:input.kind==="REMINDER"?input.recipientId:null,representativeId:input.kind==="ASSIGNMENT"?input.representativeId:null,representativePersonId:input.kind==="ASSIGNMENT"?base.selected?.account.personId??null:null,sourcePayloadSha256:base.lead.payloadSha256,sourceProfileId:base.profile?.id??null,sourceStageId:base.stage?.id??null,sourceAssignmentId:base.assignment?.id??null,createdBy:actor.actorId,createdAt:identity.now,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,payloadSchemaVersion:1,encryptedPayload,payloadSha256,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,policySnapshot:base.configured.snapshot,capturePolicyId:base.configured.capture.id,capturePolicyVersion:base.configured.capture.version,capturePolicySnapshot:base.configured.captureSnapshot,authorizationCap,requestId:deps.requestId??randomUUID()});
    await new OutboxRepository(tx,actor.organizationId).append("crm.lead_work_recorded",{leadId:row.leadId,entryId:row.id,subjectId:row.subjectId,subjectNumber:row.subjectNumber,kind:row.kind},"crm.lead.work.recorded:"+row.id,row.createdAt);
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_recorded",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,entryId:row.id,number:row.number,subjectId:row.subjectId,subjectNumber:row.subjectNumber,kind:row.kind,previousRevisionId:row.previousId,previousSubjectRevisionId:row.previousSubjectId,commandHash:row.commandHash,payloadSha256:row.payloadSha256,policyId:row.policyId,capturePolicyId:row.capturePolicyId,reviewFingerprint:row.reviewFingerprint},requestId:row.requestId,occurredAt:row.createdAt});await finalWrite(actor,tx,draft,base,row.id);return leadWorkReceipt(row,false);
  });
}
export async function recoverLeadWork(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=recoveryInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const row=await new LeadWorkRepository(tx,actor.organizationId).byNonce(input.idempotencyKey);if(!row)return{recorded:false,entry:null};if(row.createdBy!==actor.actorId)throw new LeadAccessError();const base=await context(actor,tx,row.leadId);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_recovered",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,entryId:row.id,commandHash:row.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await finalRead(actor,tx,base);return{recorded:true,entry:leadWorkReceipt(row,true)};});
}
export async function readLeadWorkHistory(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=historyInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const base=await context(actor,tx,input.leadId),rows=await base.repository.history(input.leadId,input.before),heads=new Map((await base.repository.subjectHeads(input.leadId,rows.slice(0,20).map(row=>row.subjectId))).map(row=>[row.subjectId,row._max.subjectNumber])),workHistory=rows.slice(0,20).map(row=>leadWorkHistoryItem(row,heads.get(row.subjectId)===row.subjectNumber,deps.env));await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_history_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,count:workHistory.length,before:input.before??null},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await finalRead(actor,tx,base),data={leadId:input.leadId,workRevisionId:base.current?.id??null,workHistory,next:rows.length>20?rows[19].number:null};return present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...fresh.resource,data},catalogFieldPolicy<typeof data>("lead"),fresh.now);});
}

async function currentRepresentative(actor:AccountActorContext,base:Awaited<ReturnType<typeof context>>,stored:Awaited<ReturnType<typeof authContextForAccountInTransaction>>){
  const id=base.assignment?.representativeId;if(!id)return{name:null,active:null,fingerprint:null};const account=await base.repository.assignedAccount(id);if(!account||account.personId!==base.assignment?.representativePersonId)throw new LeadWorkConflictError();let visible=id===actor.actorId;
  if(!visible){try{assertAccountAuthorization(actor,stored,base.now,[{action:"view",resource:{type:"team_member",id:account.personId,organizationId:actor.organizationId,dataClass:"personal"}}],new LeadAccessError());visible=true;}catch(error){if(!(error instanceof LeadAccessError))throw error;}}
  return{name:visible?account.person.displayName:null,active:visible?account.status==="ACTIVE"&&account.person.archivedAt===null:null,fingerprint:commandFingerprint({id:account.id,personId:account.personId,status:account.status,name:account.person.displayName,archivedAt:account.person.archivedAt?.toISOString()??null})};
}

export async function readLeadWorkOptions(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=z.object({leadId:uuid}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await context(actor,tx,input.leadId),configured=await settings(tx,actor.organizationId,base.now),stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),cap=commandFingerprint(captureAuthorizationCap(stored));
    const allowed=(action:"edit"|"assign",now=base.now,authority=stored)=>{try{assertAccountAuthorization(actor,authority,now,[{action,resource:base.resource}],new LeadAccessError());return true;}catch(error){if(error instanceof LeadAccessError)return false;throw error;}};
    const representative=await currentRepresentative(actor,base,stored),result=leadWorkOptionsSchema.parse({leadId:input.leadId,workRevisionId:base.current?.id??null,assignment:base.assignment?{...leadWorkReceipt(base.assignment,false),representativeId:base.assignment.representativeId,representativeName:representative.name,active:representative.active}:null,activityTypes:configured.policy.activity_types,reminderTransitions:configured.policy.reminders.transitions,canEdit:allowed("edit"),canAssign:allowed("assign"),accountId:actor.actorId});
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_options_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,policyId:configured.rule.id,workRevisionId:result.workRevisionId},requestId:deps.requestId??randomUUID(),occurredAt:base.now});
    const fresh=await finalRead(actor,tx,base),latest=await settings(tx,actor.organizationId,fresh.now),latestStored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),finalRepresentative=await currentRepresentative(actor,fresh,latestStored);if(representative.fingerprint!==finalRepresentative.fingerprint||representative.name!==finalRepresentative.name||representative.active!==finalRepresentative.active||result.canEdit!==allowed("edit",fresh.now,latestStored)||result.canAssign!==allowed("assign",fresh.now,latestStored)||cap!==commandFingerprint(captureAuthorizationCap(latestStored))||commandFingerprint(configured.snapshot)!==commandFingerprint(latest.snapshot)||commandFingerprint(configured.captureSnapshot)!==commandFingerprint(latest.captureSnapshot))throw new LeadWorkConflictError();return result;
  });
}

export async function listLeadWorkCandidates(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=z.object({leadId:uuid,purpose:z.enum(["REMINDER","ASSIGNMENT"]),query:z.string().trim().max(200)}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const base=await context(actor,tx,input.leadId);await editable(actor,tx,base,input.purpose);const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),actorCap=commandFingerprint(captureAuthorizationCap(stored)),accounts:Array<{id:string;displayName:string}>=[],selected:Array<{id:string;personId:string;cap:string}>=[];let before:string|undefined;
    for(let round=0;round<20&&accounts.length<20;round++){
      const rows=await base.repository.accounts(input.query,before),batch=rows.slice(0,100),authorities=await authContextsForAccountsInTransaction(tx,actor.organizationId,batch.map(row=>row.id));
      for(const row of batch){try{if(row.id!==actor.actorId)assertAccountAuthorization(actor,stored,base.now,[{action:"view",resource:{type:"team_member",id:row.personId,organizationId:actor.organizationId,dataClass:"personal"}}],new LeadAccessError());}catch(error){if(error instanceof LeadAccessError)continue;throw error;}
        const authority=authorities.get(row.id);if(!authority)continue;const resource=input.purpose==="ASSIGNMENT"?leadResource(base.lead,base.resource.status,{representativeId:row.id,representativePersonId:row.personId}):base.resource;if(!authorize({...authority,personId:row.personId},"view",resource,base.now))continue;accounts.push({id:row.id,displayName:row.person.displayName});selected.push({id:row.id,personId:row.personId,cap:commandFingerprint(captureAuthorizationCap(authority))});if(accounts.length===20)break;
      }
      if(rows.length<=100)break;before=batch[99].id;
    }
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_work_candidates_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,purpose:input.purpose,count:accounts.length,accountIds:accounts.map(account=>account.id)},requestId:deps.requestId??randomUUID(),occurredAt:base.now});
    const fresh=await finalRead(actor,tx,base);await editable(actor,tx,fresh,input.purpose);const finalStored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);if(actorCap!==commandFingerprint(captureAuthorizationCap(finalStored)))throw new LeadWorkConflictError();const latest=await authContextsForAccountsInTransaction(tx,actor.organizationId,selected.map(row=>row.id)),currentAccounts=new Map((await base.repository.accountsByIds(selected.map(row=>row.id))).map(account=>[account.id,account])),names=new Map(accounts.map(account=>[account.id,account.displayName]));
    for(const row of selected){
      const account=currentAccounts.get(row.id),authority=latest.get(row.id);
      if(!account||account.personId!==row.personId||account.person.displayName!==names.get(row.id)||!authority||commandFingerprint(captureAuthorizationCap(authority))!==row.cap)throw new LeadWorkConflictError();
      if(row.id!==actor.actorId)assertAccountAuthorization(actor,finalStored,fresh.now,[{action:"view",resource:{type:"team_member",id:row.personId,organizationId:actor.organizationId,dataClass:"personal"}}],new LeadAccessError());
      const resource=input.purpose==="ASSIGNMENT"?leadResource(fresh.lead,fresh.resource.status,{representativeId:row.id,representativePersonId:row.personId}):fresh.resource;
      if(!authorize({...authority,personId:row.personId},"view",resource,fresh.now))throw new LeadWorkConflictError();
    }
    return leadWorkCandidatesSchema.parse({accounts});
  });
}
