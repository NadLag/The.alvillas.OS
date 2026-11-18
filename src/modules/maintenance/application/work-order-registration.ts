import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {nativeMaintenanceIssue,maintenanceAuthorityStamp} from "@/platform/maintenance/issue-sources";
import {nativeMaintenanceWorkOrderTask} from "@/platform/maintenance/work-order-source";
import {MaintenanceIssueAccessError} from "../domain/issue-context";
import {workOrderRegistrationIntentSchema,workOrderRegistrationCommandSchema,workOrderRegistrationReceiptSchema,workOrderRegistrationCancellationSchema,workOrderCommandStatusSchema,WorkOrderAccessError,WorkOrderConflictError} from "../domain/work-order";
import {WorkOrderRepository} from "../infrastructure/work-order-repository";

type Dependencies={db?:TenantTransactionRunner;requestId?:string};
type Intent=z.infer<typeof workOrderRegistrationIntentSchema>;
const key=(actorId:string,nonce:string)=>"maintenance-work-order:"+actorId+":"+nonce;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
function capture(context:AccountActorContext){if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new WorkOrderAccessError();return{...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))};}
async function issueSource(actor:AccountActorContext,tx:TenantTransaction,id:string,edit=false){
 const translate=(error:unknown):never=>{if(error instanceof MaintenanceIssueAccessError)throw new WorkOrderAccessError();throw error;};
 try{const value=await nativeMaintenanceIssue(actor,tx,id,edit?"edit":"view");return{...value,recheck:async()=>{try{await value.recheck();}catch(error){translate(error);}}};}catch(error){return translate(error);}
}

async function prepare(actor:AccountActorContext,tx:TenantTransaction,intent:Intent){
 const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await issueSource(actor,tx,intent.issueId,true),task=await nativeMaintenanceWorkOrderTask(actor,tx,intent.taskId,"edit"),repository=new WorkOrderRepository(tx,actor.organizationId);
 if(task.task.propertyId!==issue.row.propertyId||await repository.original(intent.taskId))throw new WorkOrderConflictError();
 const nativeFingerprint=await repository.nativeFingerprint(intent.issueId,intent.taskId);if(!nativeFingerprint)throw new WorkOrderAccessError();
 const sourceFingerprint=jsonbFingerprint({issue:issue.fingerprint,task:task.fingerprint,stamp}),reviewFingerprint=jsonbFingerprint({intent,sourceFingerprint,nativeFingerprint});
 const verify=async()=>{await issue.recheck();await task.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx)||nativeFingerprint!==await repository.nativeFingerprint(intent.issueId,intent.taskId))throw new WorkOrderConflictError();};
 await verify();return{stamp,issue,task,repository,nativeFingerprint,sourceFingerprint,reviewFingerprint,verify};
}
async function recorded(actor:AccountActorContext,tx:TenantTransaction,nonce:string){
 const repository=new WorkOrderRepository(tx,actor.organizationId),event=await repository.outbox.byIdempotencyKey(key(actor.actorId,nonce));if(!event)return null;
 if(event.type!=="maintenance.work_order.registered")throw new WorkOrderConflictError();
 const value=workOrderRegistrationReceiptSchema.parse(event.payload);if(value.organizationId!==actor.organizationId||value.actorId!==actor.actorId||value.idempotencyKey!==nonce)throw new WorkOrderAccessError();
 if(jsonbFingerprint(value)!==jsonbFingerprint(await repository.original(value.taskId)))throw new WorkOrderConflictError();
 const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await issueSource(actor,tx,value.intent.issueId),task=await nativeMaintenanceWorkOrderTask(actor,tx,value.taskId);
 if(task.task.propertyId!==value.propertyId||issue.row.propertyId!==value.propertyId)throw new WorkOrderAccessError();
 await issue.recheck();await task.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new WorkOrderConflictError();return value;
}

export async function previewWorkOrderRegistration(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),intent=workOrderRegistrationIntentSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const value=await prepare(actor,tx,intent);return{authorizationStamp:value.stamp,intent,reviewFingerprint:value.reviewFingerprint,issue:{id:value.issue.row.id,title:value.issue.row.title},task:value.task.data};});
}
export async function publishWorkOrderRegistration(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),command=workOrderRegistrationCommandSchema.parse(raw),requestHash=jsonbFingerprint(command);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new WorkOrderRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,command.idempotencyKey);
  const existing=await recorded(actor,tx,command.idempotencyKey);if(existing){if(existing.requestHash!==requestHash)throw new WorkOrderConflictError();return{...existing,replayed:true};}
  await repository.lockTask(command.intent.taskId);const value=await prepare(actor,tx,command.intent);if(value.reviewFingerprint!==command.reviewFingerprint)throw new WorkOrderConflictError();
  const now=await repository.clock(),receipt=workOrderRegistrationReceiptSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,taskId:command.intent.taskId,propertyId:value.task.task.propertyId,intent:command.intent,idempotencyKey:command.idempotencyKey,nativeFingerprint:value.nativeFingerprint,sourceFingerprint:value.sourceFingerprint,reviewFingerprint:command.reviewFingerprint,requestHash,createdAt:now.toISOString()});
  await repository.insert(receipt);
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.registered",resourceType:"maintenance_work_order",resourceId:receipt.taskId,propertyScopeId:receipt.propertyId,after:{taskId:receipt.taskId,issueId:receipt.intent.issueId},reason:receipt.intent.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
  await repository.outbox.append("maintenance.work_order.registered",json(receipt),key(actor.actorId,command.idempotencyKey),now);await value.verify();return{...receipt,replayed:false};
 });
}
export async function recoverWorkOrderRegistration(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=z.object({issueId:z.uuid(),taskId:z.uuid().optional(),idempotencyKey:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new WorkOrderRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,input.idempotencyKey);const event=await repository.outbox.byIdempotencyKey(key(actor.actorId,input.idempotencyKey));
  if(event&&event.type!=="maintenance.work_order.cancelled"){const receipt=await recorded(actor,tx,input.idempotencyKey);if(!receipt||input.taskId&&receipt.taskId!==input.taskId||receipt.intent.issueId!==input.issueId)throw new WorkOrderAccessError();return{recorded:true as const,receipt};}
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await issueSource(actor,tx,input.issueId,true),task=input.taskId?await nativeMaintenanceWorkOrderTask(actor,tx,input.taskId,"edit"):null;if(task&&task.task.propertyId!==issue.row.propertyId)throw new WorkOrderAccessError();
  const value=workOrderRegistrationCancellationSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,...input,taskId:input.taskId??null});
  if(event){const saved=workOrderRegistrationCancellationSchema.parse(event.payload);if(saved.organizationId!==actor.organizationId||saved.actorId!==actor.actorId||saved.issueId!==input.issueId||saved.idempotencyKey!==input.idempotencyKey||input.taskId&&saved.taskId&&saved.taskId!==input.taskId)throw new WorkOrderAccessError();}
  else{const now=await repository.clock();await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.cancelled",resourceType:"maintenance_work_order_command",resourceId:input.idempotencyKey,propertyScopeId:issue.row.propertyId,after:json(value),reason:"Close an original work-order registration that was not recorded",requestId:deps.requestId??randomUUID(),occurredAt:now});await repository.outbox.append("maintenance.work_order.cancelled",json(value),key(actor.actorId,input.idempotencyKey),now);}
  await issue.recheck();if(task)await task.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new WorkOrderConflictError();return{recorded:false as const,receipt:null};
 });
}
/** An actor may confirm their own outcome after task-source access is withdrawn.
 * UNKNOWN neither closes a command nor authorizes another publication. */
export async function workOrderRegistrationCommandStatus(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=z.object({issueId:z.uuid(),idempotencyKey:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new WorkOrderRepository(tx,actor.organizationId);await repository.lockActor(actor.actorId,input.idempotencyKey);const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await issueSource(actor,tx,input.issueId),event=await repository.outbox.byIdempotencyKey(key(actor.actorId,input.idempotencyKey));let state:"RECORDED"|"CANCELLED"|"UNKNOWN"="UNKNOWN";
  if(event){if(event.type==="maintenance.work_order.registered"){const value=workOrderRegistrationReceiptSchema.parse(event.payload);if(value.organizationId!==actor.organizationId||value.actorId!==actor.actorId||value.idempotencyKey!==input.idempotencyKey||value.intent.issueId!==input.issueId)throw new WorkOrderAccessError();if(jsonbFingerprint(value)!==jsonbFingerprint(await repository.original(value.taskId)))throw new WorkOrderConflictError();state="RECORDED";}
   else if(event.type==="maintenance.work_order.cancelled"){const value=workOrderRegistrationCancellationSchema.parse(event.payload);if(value.organizationId!==actor.organizationId||value.actorId!==actor.actorId||value.idempotencyKey!==input.idempotencyKey||value.issueId!==input.issueId)throw new WorkOrderAccessError();state="CANCELLED";}else throw new WorkOrderConflictError();}
  const result=workOrderCommandStatusSchema.parse({organizationId:actor.organizationId,actorId:actor.actorId,...input,state});await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.command_status",resourceType:"maintenance_work_order_command",resourceId:input.idempotencyKey,propertyScopeId:issue.row.propertyId,after:{state},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new WorkOrderConflictError();return result;
 });
}
