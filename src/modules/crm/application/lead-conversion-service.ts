import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import {z,ZodError} from "zod";
import {Prisma,type LeadConversion} from "@prisma/client";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization,assertAccountAuthorization} from "@/platform/authz/current-authority";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {authorizeCollection} from "@/platform/authz/authorize";
import {encryptSecret,decryptSecret} from "@/platform/auth/secret-encryption";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeLeadStageEvidence} from "@/platform/documents/lead-stage-evidence";
import {createNativeLeadOwner,nativeLeadOwnerHead,nativeLeadOwnerIdentity,nativeOwnerIdentityProjection,nativeLeadOwnerInput,lockNativeLeadOwner,nativeLeadOwnerChoices,nativeLeadOwnerIdentityRows} from "@/platform/crm/lead-owner-source";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadProfileRepository} from "../infrastructure/lead-profile-repository";
import {LeadStageRepository} from "../infrastructure/lead-stage-repository";
import {LeadWorkRepository} from "../infrastructure/lead-work-repository";
import {LeadConversionRepository} from "../infrastructure/lead-conversion-repository";
import {leadResource} from "./lead-resource";
import {retainedLeadProfile} from "./lead-profile-snapshot";
import {leadCaptureBinding,type LeadDependencies} from "./lead-capture-service";
import {decryptLeadPayload,requireLeadPayloadKeys} from "../domain/lead-payload";
import {leadCapturePolicyKey,leadCapturePolicySchema,LeadAccessError,LeadConfigurationError,LeadRateLimitError} from "../domain/lead-capture";
import {leadPipelinePolicyKey,leadPipelinePolicySchema,nativeLeadStageProofSchema,LeadPipelineEvidenceError} from "../domain/lead-pipeline";
import {canonicalLeadConversionDraft,canonicalLeadConversionCommand,leadConversionPolicyKey,leadConversionPolicySchema,leadConversionOptionsSchema,leadConversionChoicesSchema,LeadConversionConflictError,type LeadConversionDraft} from "../domain/lead-conversion";
import {encryptLeadConversionPayload,decryptLeadConversionPayload} from "../domain/lead-conversion-payload";

const uuid=z.uuid().transform(value=>value.toLowerCase()),recoverSchema=z.object({idempotencyKey:uuid}).strict(),readSchema=z.object({leadId:uuid}).strict(),protocol="NATIVE_PRIVATE_LEAD_OWNER_CONVERSION_V1";
const signedKinds=["PROPOSAL_VERSION","CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE"]as const;
const ownerResource=(organizationId:string,owner?:{id:string;createdAt:Date})=>({type:"owner",organizationId,id:owner?.id,ownerId:owner?.id,dataClass:"personal"as const,occurredAt:owner?.createdAt});
async function leadSnapshot(actor:AccountActorContext,tx:TenantTransaction,leadId:string){
 const leads=new LeadRepository(tx,actor.organizationId),lead=await leads.byId(leadId);if(!lead)throw new LeadAccessError();
 const profile=await new LeadProfileRepository(tx,actor.organizationId).current(leadId),stage=await new LeadStageRepository(tx,actor.organizationId).current(leadId),assignment=await new LeadWorkRepository(tx,actor.organizationId).currentAssignment(leadId),resource=leadResource(lead,stage?.toStage??lead.initialStage,assignment),now=await leads.clock();
 return{lead,profile,stage,assignment,resource,now};
}
async function leadContext(actor:AccountActorContext,tx:TenantTransaction,leadId:string){
 const base=await leadSnapshot(actor,tx,leadId);await recheckAccountAuthorization(actor,tx,base.now,[{action:"view",resource:base.resource}],new LeadAccessError());return base;
}
async function ownerRead(actor:AccountActorContext,tx:TenantTransaction,ownerId:string,write=false){
 const owner=await nativeLeadOwnerHead(tx,actor.organizationId,ownerId,!write);if(!owner)throw new LeadAccessError();
 await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),[{action:"view",resource:ownerResource(actor.organizationId,owner)},...write?[{action:"edit"as const,resource:ownerResource(actor.organizationId,owner)}]:[]],new LeadAccessError());return owner;
}
async function conversionAuthority(actor:AccountActorContext,tx:TenantTransaction,base:Awaited<ReturnType<typeof leadContext>>,input:LeadConversionDraft){
 await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),(["view","export","edit"]as const).map(action=>({action,resource:base.resource})),new LeadAccessError());
 if(input.target.mode==="LINK")return ownerRead(actor,tx,input.target.ownerId,true);
 await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),[{action:"create",resource:ownerResource(actor.organizationId),organizationOnly:true},{action:"view",resource:ownerResource(actor.organizationId),organizationOnly:true}],new LeadAccessError());return null;
}
async function settings(tx:TenantTransaction,organizationId:string,now:Date){
 try{
  const config=new ConfigRuleRepository(tx,organizationId),scopes=[{scopeType:"organization"as const,scopeId:null}],rule=await config.resolve({key:leadConversionPolicyKey,scopes,asOf:now}),capture=await config.resolve({key:leadCapturePolicyKey,scopes,asOf:now}),pipeline=await config.resolve({key:leadPipelinePolicyKey,scopes,asOf:now});
  if(!rule?.createdBy||!capture?.createdBy||!pipeline?.createdBy)throw new LeadConfigurationError();
  leadCapturePolicySchema.parse(capture.parsedValue);const policy=leadConversionPolicySchema.parse(rule.parsedValue),pipelinePolicy=leadPipelinePolicySchema.parse(pipeline.parsedValue);
  return{rule,policy,pipelinePolicy,snapshot:{id:rule.id,version:rule.version,value:rule.value},captureSnapshot:{id:capture.id,version:capture.version,value:capture.value},pipelineSnapshot:{id:pipeline.id,version:pipeline.version,value:pipeline.value}};
 }catch(error){if(error instanceof ZodError)throw new LeadConfigurationError();throw error;}
}
async function reviewed(actor:AccountActorContext,tx:TenantTransaction,input:LeadConversionDraft,deps:LeadDependencies){
 const base=await leadContext(actor,tx,input.leadId);await conversionAuthority(actor,tx,base,input);
 if((base.profile?.id??null)!==input.profileRevisionId||base.stage?.id!==input.signedStageId||base.stage.toStage!=="SIGNED")throw new LeadConversionConflictError();
 const existing=await new LeadConversionRepository(tx,actor.organizationId).byLead(input.leadId);if(existing)throw new LeadConversionConflictError();
 const configured=await settings(tx,actor.organizationId,base.now);if(!configured.policy.modes.includes(input.target.mode))throw new LeadConfigurationError();
 const retained=z.array(nativeLeadStageProofSchema).parse(base.stage.evidence),references=retained.filter(proof=>signedKinds.some(kind=>kind===proof.kind)).map(proof=>({kind:proof.kind,sourceId:proof.sourceId}));
 const evidence=await nativeLeadStageEvidence(actor,tx,{leadId:input.leadId,previousRevisionId:base.stage.id,toStage:"SIGNED",evidenceReferences:references},signedKinds,configured.pipelinePolicy,base.now,deps),archive=evidence.find(proof=>proof.kind==="SIGNATURE_SIGNED_ARCHIVE");if(!archive)throw new LeadPipelineEvidenceError();
 const source=base.profile?retainedLeadProfile(base.profile,deps.env):decryptLeadPayload(base.lead.encryptedPayload,leadCaptureBinding(base.lead),deps.env);
 const selected=input.target.mode==="LINK"?await nativeLeadOwnerIdentity(tx,actor.organizationId,input.target.ownerId):null;if(input.target.mode==="LINK"&&!selected)throw new LeadAccessError();
 const mapped=selected?null:nativeLeadOwnerInput(source),owner=selected?nativeOwnerIdentityProjection(selected):nativeOwnerIdentityProjection({...mapped!,email:mapped!.email??null,phone:mapped!.phone??null});
 const sourceSnapshot={leadId:base.lead.id,capturePayloadSha256:base.lead.payloadSha256,profileRevisionId:base.profile?.id??null,profilePayloadSha256:base.profile?.payloadSha256??null,signedStageId:base.stage.id,signedStageCommandHash:base.stage.commandHash,signedArchiveId:archive.sourceId,signedArchiveFingerprint:archive.sourceFingerprint,assignmentRevisionId:base.assignment?.id??null},sourceFingerprint=commandFingerprint(sourceSnapshot);
 const reviewFingerprint=commandFingerprint({protocol,input,sourceSnapshot,owner,ownerUpdatedAt:selected?.updatedAt.toISOString()??null,configuration:{conversion:configured.snapshot,capture:configured.captureSnapshot,pipeline:configured.pipelineSnapshot},evidence,authorizationCap:captureAuthorizationCap(actor.authContext)});
 return{...base,configured,source,owner,ownerCreatedAt:selected?.createdAt??base.now,sourceSnapshot,sourceFingerprint,reviewFingerprint,evidence};
}
function binding(row:LeadConversion){if(row.payloadSchemaVersion!==1)throw new LeadConfigurationError();return{organizationId:row.organizationId,leadId:row.leadId,conversionId:row.id,ownerId:row.ownerId,createdBy:row.createdBy,commandKey:row.commandKey,policyId:row.policyId,policyVersion:row.policyVersion};}
function retained(row:LeadConversion,env?:NodeJS.ProcessEnv){const value=decryptLeadConversionPayload(row.encryptedPayload,binding(row),env);if(value.command.reviewFingerprint!==row.reviewFingerprint||value.command.signedStageId!==row.signedStageId||value.command.profileRevisionId!==row.profileRevisionId||value.command.target.mode!==row.mode)throw new LeadConfigurationError();return value;}
function receipt(row:LeadConversion,replayed:boolean){return{id:row.id,leadId:row.leadId,ownerId:row.ownerId,mode:row.mode,profileRevisionId:row.profileRevisionId,signedStageId:row.signedStageId,signedArchiveId:row.signedArchiveId,sourceKey:row.sourceKey,locale:row.locale,createdAt:row.createdAt.toISOString(),replayed};}
async function readFence(actor:AccountActorContext,tx:TenantTransaction,row:LeadConversion,base:Awaited<ReturnType<typeof leadContext>>){
 const fresh=await leadContext(actor,tx,row.leadId),owner=await ownerRead(actor,tx,row.ownerId);if(fresh.stage?.id!==base.stage?.id||fresh.profile?.id!==base.profile?.id||(fresh.assignment?.id??null)!==(base.assignment?.id??null))throw new LeadConversionConflictError();return{...fresh,owner};
}
async function recovered(actor:AccountActorContext,tx:TenantTransaction,row:LeadConversion,deps:LeadDependencies,command?:ReturnType<typeof canonicalLeadConversionCommand>){
 if(row.createdBy!==actor.actorId)throw new LeadAccessError();const base=await leadContext(actor,tx,row.leadId);await ownerRead(actor,tx,row.ownerId);
 if(command&&!timingSafeEqual(Buffer.from(commandFingerprint(retained(row,deps.env).command),"hex"),Buffer.from(commandFingerprint(command),"hex")))throw new LeadConversionConflictError();
 await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_recovered",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,conversionId:row.id,ownerId:row.ownerId,commandHash:row.commandHash},requestId:deps.requestId??randomUUID(),occurredAt:base.now});await readFence(actor,tx,row,base);return receipt(row,true);
}
export async function reviewLeadConversion(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=canonicalLeadConversionDraft(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const base=await reviewed(actor,tx,input,deps);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_reviewed",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,mode:input.target.mode,sourceFingerprint:base.sourceFingerprint,reviewFingerprint:base.reviewFingerprint,policyId:base.configured.rule.id},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await reviewed(actor,tx,input,deps);if(fresh.reviewFingerprint!==base.reviewFingerprint)throw new LeadConversionConflictError();
  return{...input,reviewFingerprint:base.reviewFingerprint,owner:present({...actor.authContext,visibleDataClasses:new Set(["personal"]as const)},input.target.mode==="CREATE"?"create":"view",{...ownerResource(actor.organizationId,input.target.mode==="LINK"?{id:input.target.ownerId,createdAt:base.ownerCreatedAt}:undefined),data:base.owner},{},base.now)};
 });
}
export async function admitLeadConversion(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=canonicalLeadConversionCommand(raw),draft=canonicalLeadConversionDraft({leadId:input.leadId,profileRevisionId:input.profileRevisionId,signedStageId:input.signedStageId,target:input.target});
 const budget=await withTenant(deps.db,actor.organizationId,async tx=>{
  const existing=await new LeadConversionRepository(tx,actor.organizationId).byNonce(input.idempotencyKey);if(existing){if(existing.createdBy!==actor.actorId||existing.leadId!==input.leadId)throw new LeadAccessError();return null;}
  const base=await leadContext(actor,tx,input.leadId);await conversionAuthority(actor,tx,base,input);const configured=await settings(tx,actor.organizationId,base.now),decision=await consumeRateLimit(tx,actor.organizationId,{key:"crm.lead_conversion:organization",limit:configured.policy.admission.requests,windowSeconds:configured.policy.admission.window_seconds,now:base.now});return{configured,decision};
 });if(budget&&!budget.decision.allowed)throw new LeadRateLimitError(budget.decision.resetAt);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const config=new ConfigRuleRepository(tx,actor.organizationId);for(const key of[leadCapturePolicyKey,leadConversionPolicyKey,leadPipelinePolicyKey])await config.lockVersion(key,"organization",null);
  await new LeadStageRepository(tx,actor.organizationId).lockLead(input.leadId);await new LeadProfileRepository(tx,actor.organizationId).lockLead(input.leadId);await new LeadWorkRepository(tx,actor.organizationId).lockLead(input.leadId);const repository=new LeadConversionRepository(tx,actor.organizationId);await repository.lockLead(input.leadId);await repository.lockCommand(input.idempotencyKey);
  const existing=await repository.byNonce(input.idempotencyKey);if(existing)return recovered(actor,tx,existing,deps,input);
  if(input.target.mode==="LINK"){await ownerRead(actor,tx,input.target.ownerId,true);await lockNativeLeadOwner(tx,actor.organizationId,input.target.ownerId);}
  const base=await reviewed(actor,tx,draft,deps);if(!budget||base.reviewFingerprint!==input.reviewFingerprint||commandFingerprint(base.configured.snapshot)!==commandFingerprint(budget.configured.snapshot))throw new LeadConversionConflictError();
  const requestId=deps.requestId??randomUUID(),owner=input.target.mode==="CREATE"?await createNativeLeadOwner(actor,tx,base.source,requestId):await nativeLeadOwnerIdentity(tx,actor.organizationId,input.target.ownerId);if(!owner)throw new LeadAccessError();
  const createdAt=await new LeadRepository(tx,actor.organizationId).clock();
  await recheckAccountAuthorization(actor,tx,createdAt,[{action:"view",resource:ownerResource(actor.organizationId,owner)},{action:input.target.mode==="CREATE"?"create":"edit",resource:ownerResource(actor.organizationId,owner)}],new LeadAccessError());
  const id=randomUUID(),authorizationCap=captureAuthorizationCap(actor.authContext),encryptedPayload=encryptLeadConversionPayload({command:input,originalOwner:base.owner},{organizationId:actor.organizationId,leadId:input.leadId,conversionId:id,ownerId:owner.id,createdBy:actor.actorId,commandKey:input.idempotencyKey,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version},deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),commandHash=commandFingerprint({protocol,input,payloadSha256,sourceFingerprint:base.sourceFingerprint,authorizationCap});
  const row=await repository.create({id,leadId:input.leadId,profileRevisionId:input.profileRevisionId,signedStageId:input.signedStageId,signedArchiveId:base.sourceSnapshot.signedArchiveId,ownerId:owner.id,mode:input.target.mode,sourceKey:base.source.sourceKey,locale:base.source.locale,createdBy:actor.actorId,createdAt,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,sourceFingerprint:base.sourceFingerprint,sourceSnapshot:base.sourceSnapshot,payloadSchemaVersion:1,encryptedPayload,payloadSha256,policyId:base.configured.rule.id,policyVersion:base.configured.rule.version,policySnapshot:base.configured.snapshot,authorizationCap,requestId});
  if(row.createdBy!==actor.actorId||row.ownerId!==owner.id||row.policyId!==base.configured.rule.id||row.sourceFingerprint!==base.sourceFingerprint||commandFingerprint(retained(row,deps.env).command)!==commandFingerprint(input))throw new LeadConversionConflictError();
  await new OutboxRepository(tx,actor.organizationId).append("crm.lead_converted",{leadId:row.leadId,conversionId:row.id,ownerId:row.ownerId,mode:row.mode},"crm.lead.converted:"+row.id,row.createdAt);
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_converted",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,conversionId:row.id,ownerId:row.ownerId,mode:row.mode,profileRevisionId:row.profileRevisionId,signedStageId:row.signedStageId,signedArchiveId:row.signedArchiveId,sourceKey:row.sourceKey,commandHash:row.commandHash,payloadSha256:row.payloadSha256,sourceFingerprint:row.sourceFingerprint,reviewFingerprint:row.reviewFingerprint,policyId:row.policyId},requestId,occurredAt:row.createdAt});
  await repository.validateBirth();const fresh=await leadContext(actor,tx,row.leadId);await conversionAuthority(actor,tx,fresh,input);const configured=await settings(tx,actor.organizationId,fresh.now);
  if(fresh.stage?.id!==base.stage?.id||fresh.profile?.id!==base.profile?.id||(fresh.assignment?.id??null)!==(base.assignment?.id??null)||commandFingerprint(configured)!==commandFingerprint(base.configured))throw new LeadConversionConflictError();
  const references=z.array(nativeLeadStageProofSchema).parse(fresh.stage!.evidence).filter(proof=>signedKinds.some(kind=>kind===proof.kind)).map(proof=>({kind:proof.kind,sourceId:proof.sourceId})),evidence=await nativeLeadStageEvidence(actor,tx,{leadId:row.leadId,previousRevisionId:fresh.stage!.id,toStage:"SIGNED",evidenceReferences:references},signedKinds,configured.pipelinePolicy,fresh.now,deps);if(commandFingerprint(evidence)!==commandFingerprint(base.evidence))throw new LeadConversionConflictError();
  const ownerNow=await nativeLeadOwnerIdentity(tx,actor.organizationId,row.ownerId);if(!ownerNow||commandFingerprint(nativeOwnerIdentityProjection(ownerNow))!==commandFingerprint(base.owner))throw new LeadConversionConflictError();await ownerRead(actor,tx,row.ownerId,input.target.mode==="LINK");await recheckAccountAuthorization(actor,tx,await new LeadRepository(tx,actor.organizationId).clock(),[{action:input.target.mode==="CREATE"?"create":"edit",resource:ownerResource(actor.organizationId,ownerNow)}],new LeadAccessError());return receipt(row,false);
 }).catch(error=>{if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==="P2002")throw new LeadConversionConflictError();throw error;});
}
export async function recoverLeadConversion(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=recoverSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const repository=new LeadConversionRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);const row=await repository.byNonce(input.idempotencyKey);return row?{recorded:true,conversion:await recovered(actor,tx,row,deps)}:{recorded:false,conversion:null};});
}
export async function readLeadConversion(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=readSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const base=await leadContext(actor,tx,input.leadId),row=await new LeadConversionRepository(tx,actor.organizationId).byLead(input.leadId);
  if(!row){await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,conversionId:null,ownerId:null},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await leadContext(actor,tx,input.leadId);if(fresh.stage?.id!==base.stage?.id||fresh.profile?.id!==base.profile?.id||(fresh.assignment?.id??null)!==(base.assignment?.id??null))throw new LeadConversionConflictError();return{conversion:null};}
  await ownerRead(actor,tx,row.ownerId);const value=retained(row,deps.env);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_read",resourceType:"lead",resourceId:row.leadId,after:{leadId:row.leadId,conversionId:row.id,ownerId:row.ownerId},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await readFence(actor,tx,row,base),reason=present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...fresh.resource,data:{reason:value.command.reason}},{reason:{dataClass:"personal",requiredPermission:"lead:view",mask:"omit"}},fresh.now).reason;
  return{conversion:receipt(row,false),originalOwner:present({...actor.authContext,visibleDataClasses:new Set(["personal"]as const)},"view",{...ownerResource(actor.organizationId,fresh.owner),data:value.originalOwner},{},fresh.now),reason};
 });
}

export async function readLeadConversionOptions(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=readSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const base=await leadContext(actor,tx,input.leadId),existing=await new LeadConversionRepository(tx,actor.organizationId).byLead(input.leadId),modes:Array<"CREATE"|"LINK">=[];
  if(existing)await ownerRead(actor,tx,existing.ownerId);
  if(!existing&&base.stage?.toStage==="SIGNED"){
   const configured=await settings(tx,actor.organizationId,base.now);
   await recheckAccountAuthorization(actor,tx,base.now,(["view","export","edit"]as const).map(action=>({action,resource:base.resource})),new LeadAccessError());
   for(const mode of configured.policy.modes){try{if(mode==="CREATE")await conversionAuthority(actor,tx,base,{leadId:input.leadId,profileRevisionId:base.profile?.id??null,signedStageId:base.stage.id,target:{mode}});else{const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);if(![actor.authContext,stored].every(cap=>authorizeCollection(cap,"view","owner")&&authorizeCollection(cap,"edit","owner")))continue;}modes.push(mode);}catch(error){if(!(error instanceof LeadAccessError))throw error;}}
  }
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_options_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,converted:!!existing},requestId:deps.requestId??randomUUID(),occurredAt:base.now});const fresh=await leadContext(actor,tx,input.leadId);if(fresh.profile?.id!==base.profile?.id||fresh.stage?.id!==base.stage?.id||(fresh.assignment?.id??null)!==(base.assignment?.id??null))throw new LeadConversionConflictError();if(existing)await ownerRead(actor,tx,existing.ownerId);else if(modes.length)await recheckAccountAuthorization(actor,tx,fresh.now,(["view","export","edit"]as const).map(action=>({action,resource:fresh.resource})),new LeadAccessError());
  return leadConversionOptionsSchema.parse({leadId:input.leadId,profileRevisionId:base.profile?.id??null,signedStageId:base.stage?.toStage==="SIGNED"?base.stage.id:null,modes,converted:!!existing});
 });
}

const choicesInput=z.object({leadId:uuid,query:z.string().trim().min(1).max(160).transform(value=>value.normalize("NFC")),cursor:z.string().min(1).max(8192).optional()}).strict();
const choicesCursor=z.object({protocol:z.literal("NATIVE_LEAD_OWNER_CHOICES_V1"),organizationId:uuid,actorId:uuid,leadId:uuid,filter:z.string(),cap:z.string(),beforeId:uuid,asOf:z.iso.datetime()}).strict();
export async function readLeadConversionChoices(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
 const input=choicesInput.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  // One current grant snapshot per read phase, following the Lead workspace.
  // Reload it after the audit; no authority is cached across that boundary.
  const base=await leadSnapshot(actor,tx,input.leadId),stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);assertAccountAuthorization(actor,stored,base.now,(["view","export","edit"]as const).map(action=>({action,resource:base.resource})),new LeadAccessError());
  const configured=await settings(tx,actor.organizationId,base.now);if(base.stage?.toStage!=="SIGNED"||!configured.policy.modes.includes("LINK")||await new LeadConversionRepository(tx,actor.organizationId).byLead(input.leadId))throw new LeadConversionConflictError();
  if(![actor.authContext,stored].every(cap=>authorizeCollection(cap,"view","owner")&&authorizeCollection(cap,"edit","owner")))throw new LeadAccessError();const cap=commandFingerprint({held:captureAuthorizationCap(actor.authContext),stored:captureAuthorizationCap(stored)}),filter=commandFingerprint({leadId:input.leadId,query:input.query,policy:configured.snapshot});
  let after:string|undefined,asOf=base.now;if(input.cursor){try{requireLeadPayloadKeys(deps.env??process.env,false);const cursor=choicesCursor.parse(JSON.parse(decryptSecret(input.cursor,deps.env)));if(cursor.organizationId!==actor.organizationId||cursor.actorId!==actor.actorId||cursor.leadId!==input.leadId||cursor.filter!==filter||cursor.cap!==cap||Date.parse(cursor.asOf)>base.now.getTime())throw new LeadConversionConflictError();after=cursor.beforeId;asOf=new Date(cursor.asOf);}catch{throw new LeadConversionConflictError();}}
  type Owner=Awaited<ReturnType<typeof nativeLeadOwnerChoices>>[number];const owners:Owner[]=[];let more=false,scanned:string|undefined;
  for(let round=0;round<20;round++){const candidates=await nativeLeadOwnerChoices(tx,actor.organizationId,input.query,after,asOf),batch=candidates.slice(0,50);for(const candidate of batch){scanned=candidate.id;try{assertAccountAuthorization(actor,stored,base.now,(["view","edit"]as const).map(action=>({action,resource:ownerResource(actor.organizationId,candidate)})),new LeadAccessError());}catch(error){if(error instanceof LeadAccessError)continue;throw error;}owners.push(candidate);if(owners.length===21)break;}if(owners.length===21){more=true;break;}if(candidates.length<=50){more=false;break;}after=batch[49].id;more=true;}
  const published=owners.slice(0,20),nextPointer=owners.length===21?published[19].id:more?scanned:undefined;
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_conversion_owner_choices_read",resourceType:"lead",resourceId:input.leadId,after:{leadId:input.leadId,filterFingerprint:filter,ownerIds:published.map(owner=>owner.id),count:published.length},requestId:deps.requestId??randomUUID(),occurredAt:base.now});
  const fresh=await leadSnapshot(actor,tx,input.leadId),current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);assertAccountAuthorization(actor,current,fresh.now,(["view","export","edit"]as const).map(action=>({action,resource:fresh.resource})),new LeadAccessError());const rows=new Map((await nativeLeadOwnerIdentityRows(tx,actor.organizationId,published.map(owner=>owner.id))).map(owner=>[owner.id,owner]));if(commandFingerprint({held:captureAuthorizationCap(actor.authContext),stored:captureAuthorizationCap(current)})!==cap||fresh.profile?.id!==base.profile?.id||fresh.stage?.id!==base.stage?.id||(fresh.assignment?.id??null)!==(base.assignment?.id??null))throw new LeadConversionConflictError();
  if(commandFingerprint((await settings(tx,actor.organizationId,fresh.now)).snapshot)!==commandFingerprint(configured.snapshot))throw new LeadConversionConflictError();
  for(const owner of published){const row=rows.get(owner.id);if(!row||commandFingerprint(row)!==commandFingerprint(owner))throw new LeadConversionConflictError();assertAccountAuthorization(actor,current,fresh.now,(["view","edit"]as const).map(action=>({action,resource:ownerResource(actor.organizationId,owner)})),new LeadAccessError());}
  let next:string|null=null;if(nextPointer){requireLeadPayloadKeys(deps.env??process.env,true);next=encryptSecret(JSON.stringify({protocol:"NATIVE_LEAD_OWNER_CHOICES_V1",organizationId:actor.organizationId,actorId:actor.actorId,leadId:input.leadId,filter,cap,beforeId:nextPointer,asOf:asOf.toISOString()}),deps.env);}
  return leadConversionChoicesSchema.parse({owners:published.map(owner=>present({...actor.authContext,visibleDataClasses:new Set(["personal"]as const)},"view",{...ownerResource(actor.organizationId,owner),data:{id:owner.id,displayName:owner.displayName,email:owner.email}},{},fresh.now)),next});
 });
}
