import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeMaintenanceIssue,inspectMaintenanceIssueSource,maintenanceAuthorityStamp,type MaintenanceAssetSource} from "@/platform/maintenance/issue-sources";
import {MaintenanceIssueContextRepository} from "../infrastructure/issue-context-repository";
import {maintenanceIssueLinkIntentSchema,maintenanceIssueLinkCommandSchema,maintenanceIssueLinkReceiptSchema,maintenanceIssueLinkCancellationSchema,maintenanceIssueCommandStatusSchema,MaintenanceIssueAccessError,MaintenanceIssueConflictError} from "../domain/issue-context";

type Dependencies={db?:TenantTransactionRunner;requestId?:string;assets?:MaintenanceAssetSource};
type Intent=z.infer<typeof maintenanceIssueLinkIntentSchema>;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const key=(actorId:string,nonce:string)=>"maintenance-issue-context:"+actorId+":"+nonce;
function capture(context:AccountActorContext){if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();return{...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))};}

async function prepare(actor:AccountActorContext,tx:TenantTransaction,intent:Intent,deps:Dependencies){
 const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,intent.issueId,"edit"),repository=new MaintenanceIssueContextRepository(tx,actor.organizationId),latest=await repository.latest(intent.issueId),prior=await repository.sourceHead(intent.issueId,intent.source);
 if(intent.expectedVersion!==(latest?.version??"0")||intent.operation==="ATTACH"&&prior?.operation==="ATTACH"||intent.operation==="DETACH"&&prior?.operation!=="ATTACH")throw new MaintenanceIssueConflictError();
 const source=await inspectMaintenanceIssueSource(actor,tx,intent.source,issue.context,deps.assets),nativeFingerprint=await repository.nativeFingerprint(intent.issueId,intent.source);
 if(!nativeFingerprint||intent.operation==="ATTACH"&&(await repository.active(intent.issueId)).length>=50)throw new MaintenanceIssueConflictError();
 const sourceFingerprint=jsonbFingerprint({issue:issue.fingerprint,source:source.fingerprint,stamp}),reviewFingerprint=jsonbFingerprint({intent,sourceFingerprint,nativeFingerprint,latest,prior});
 const verify=async(recorded=false)=>{
  await source.recheck();await issue.recheck();
  if(stamp!==await maintenanceAuthorityStamp(actor,tx)||nativeFingerprint!==await repository.nativeFingerprint(intent.issueId,intent.source))throw new MaintenanceIssueConflictError();
  if(!recorded&&(jsonbFingerprint(latest)!==jsonbFingerprint(await repository.latest(intent.issueId))||jsonbFingerprint(prior)!==jsonbFingerprint(await repository.sourceHead(intent.issueId,intent.source))))throw new MaintenanceIssueConflictError();
 };
 await verify();return{authorizationStamp:stamp,repository,issue,source,latest,nativeFingerprint,sourceFingerprint,reviewFingerprint,verify};
}
async function saved(actor:AccountActorContext,tx:TenantTransaction,nonce:string,deps:Dependencies){
 const repository=new MaintenanceIssueContextRepository(tx,actor.organizationId),event=await repository.outbox.byIdempotencyKey(key(actor.actorId,nonce));if(!event)return null;
 if(event.type!=="maintenance.issue.context.recorded")throw new MaintenanceIssueConflictError();
 const value=maintenanceIssueLinkReceiptSchema.parse(event.payload);
 if(value.organizationId!==actor.organizationId||value.actorId!==actor.actorId||value.idempotencyKey!==nonce)throw new MaintenanceIssueAccessError();
 const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,value.intent.issueId),source=await inspectMaintenanceIssueSource(actor,tx,value.intent.source,issue.context,deps.assets);
 if(jsonbFingerprint(value)!==jsonbFingerprint(await repository.original(value.contextId)))throw new MaintenanceIssueConflictError();
 await source.recheck();await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new MaintenanceIssueConflictError();return value;
}

export async function previewMaintenanceIssueLink(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),intent=maintenanceIssueLinkIntentSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const value=await prepare(actor,tx,intent,deps);return{authorizationStamp:value.authorizationStamp,intent,reviewFingerprint:value.reviewFingerprint,source:{reference:value.source.reference,label:value.source.label,dataClass:value.source.dataClass,...value.source.labels?{labels:value.source.labels}:{},...value.source.navigation?{navigation:value.source.navigation}:{}}};});
}
export async function publishMaintenanceIssueLink(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),command=maintenanceIssueLinkCommandSchema.parse(raw),requestHash=jsonbFingerprint(command);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new MaintenanceIssueContextRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,command.idempotencyKey);
  const existing=await saved(actor,tx,command.idempotencyKey,deps);if(existing){if(existing.requestHash!==requestHash)throw new MaintenanceIssueConflictError();return{...existing,replayed:true};}
  await repository.lockIssue(command.intent.issueId);const value=await prepare(actor,tx,command.intent,deps);if(value.reviewFingerprint!==command.reviewFingerprint)throw new MaintenanceIssueConflictError();
  const identity=await repository.identity(),receipt=maintenanceIssueLinkReceiptSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,contextId:identity.id,previousId:value.latest?.id??null,version:(BigInt(command.intent.expectedVersion)+1n).toString(),intent:command.intent,idempotencyKey:command.idempotencyKey,requestHash,reviewFingerprint:command.reviewFingerprint,nativeFingerprint:value.nativeFingerprint,sourceFingerprint:value.sourceFingerprint,createdAt:identity.now.toISOString()});
  await repository.insert(receipt);
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:command.intent.operation==="ATTACH"?"maintenance.issue.context.attached":"maintenance.issue.context.detached",resourceType:"maintenance_issue_context",resourceId:receipt.contextId,propertyScopeId:value.issue.row.propertyId,after:{issueId:command.intent.issueId,version:receipt.version,operation:command.intent.operation,sourceKind:command.intent.source.kind},reason:command.intent.reason,requestId:deps.requestId??randomUUID(),occurredAt:identity.now});
  await repository.outbox.append("maintenance.issue.context.recorded",json(receipt),key(actor.actorId,command.idempotencyKey),identity.now);
  await value.verify(true);return{...receipt,replayed:false};
 });
}
export async function recoverMaintenanceIssueLink(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=z.object({issueId:z.uuid(),idempotencyKey:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new MaintenanceIssueContextRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,input.idempotencyKey);
  const event=await repository.outbox.byIdempotencyKey(key(actor.actorId,input.idempotencyKey));
  if(event&&event.type!=="maintenance.issue.context.cancelled"){const receipt=await saved(actor,tx,input.idempotencyKey,deps);if(receipt?.intent.issueId!==input.issueId)throw new MaintenanceIssueAccessError();return{recorded:true as const,receipt};}
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId,"edit"),value=maintenanceIssueLinkCancellationSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,...input});
  if(event){if(jsonbFingerprint(event.payload)!==jsonbFingerprint(value))throw new MaintenanceIssueAccessError();}
  else{const {now}=await repository.identity();await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.context.cancelled",resourceType:"maintenance_issue_context_command",resourceId:input.idempotencyKey,propertyScopeId:issue.row.propertyId,after:json(value),reason:"Close an original issue-context command that was not recorded",requestId:deps.requestId??randomUUID(),occurredAt:now});await repository.outbox.append("maintenance.issue.context.cancelled",json(value),key(actor.actorId,input.idempotencyKey),now);}
  await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new MaintenanceIssueConflictError();return{recorded:false as const,receipt:null};
 });
}

/** Confirm only the caller's own command outcome when its linked private body
 * is no longer readable. UNKNOWN is not a negative closure or permission to retry. */
export async function maintenanceIssueCommandStatus(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=z.object({issueId:z.uuid(),idempotencyKey:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new MaintenanceIssueContextRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,input.idempotencyKey);
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),event=await repository.outbox.byIdempotencyKey(key(actor.actorId,input.idempotencyKey)),base={organizationId:actor.organizationId,actorId:actor.actorId,...input};
  let result;
  if(!event)result={...base,state:"UNKNOWN" as const};
  else if(event.type==="maintenance.issue.context.cancelled"){
   const value=maintenanceIssueLinkCancellationSchema.parse(event.payload);if(jsonbFingerprint(value)!==jsonbFingerprint({schemaVersion:1,...base}))throw new MaintenanceIssueAccessError();result={...base,state:"CANCELLED" as const};
  }else if(event.type==="maintenance.issue.context.recorded"){
   const value=maintenanceIssueLinkReceiptSchema.parse(event.payload);if(value.organizationId!==actor.organizationId||value.actorId!==actor.actorId||value.idempotencyKey!==input.idempotencyKey||value.intent.issueId!==input.issueId)throw new MaintenanceIssueAccessError();
   if(jsonbFingerprint(value)!==jsonbFingerprint(await repository.original(value.contextId)))throw new MaintenanceIssueConflictError();result={...base,state:"RECORDED" as const,contextId:value.contextId,version:value.version};
  }else throw new MaintenanceIssueConflictError();
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.context.command_status",resourceType:"maintenance_issue_context_command",resourceId:input.idempotencyKey,propertyScopeId:issue.row.propertyId,after:{state:result.state},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new MaintenanceIssueConflictError();return maintenanceIssueCommandStatusSchema.parse(result);
 });
}
