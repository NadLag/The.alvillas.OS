import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {authorizationScopeStamp} from "@/platform/authz/authority-stamp";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {nativeMaintenanceIssue,maintenanceAuthorityStamp} from "@/platform/maintenance/issue-sources";
import {nativeMaintenanceWorkOrderTask} from "@/platform/maintenance/work-order-source";
import {maintenanceSourceCursor,readMaintenanceSourceCursor} from "@/platform/maintenance/source-cursor";
import {WorkOrderRepository} from "../infrastructure/work-order-repository";
import {MaintenanceIssueAccessError} from "../domain/issue-context";
import {workOrderTaskChoicesSchema,workOrderListSchema,WorkOrderAccessError,WorkOrderConflictError} from "../domain/work-order";

type Dependencies={db?:TenantTransactionRunner;requestId?:string};
const inputSchema=z.object({issueId:z.uuid(),query:z.string().trim().max(120).default(""),cursor:z.string().max(6000).optional()}).strict();
function capture(context:AccountActorContext){if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new WorkOrderAccessError();return{...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))};}
/** Only canonical maintenance tasks may become work orders; selectors do not
 * create tasks or reveal records outside the original per-task authority. */
export async function workOrderTaskChoices(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=inputSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId,"edit"),repository=new WorkOrderRepository(tx,actor.organizationId),filter=jsonbFingerprint({purpose:"MAINTENANCE_WORK_ORDER_TASKS",issueId:input.issueId,query:input.query,stamp,held:authorizationScopeStamp(actor.authContext)}),before=readMaintenanceSourceCursor(actor,filter,input.cursor),rows=await repository.candidates(issue.row.propertyId,input.query,before),items=[],checks:Array<()=>Promise<void>>=[];
  for(const row of rows.slice(0,20)){try{const source=await nativeMaintenanceWorkOrderTask(actor,tx,row.id,"edit");items.push(source.data);checks.push(source.recheck);}catch(error){if(!(error instanceof WorkOrderAccessError))throw error;}}
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.tasks.read",resourceType:"maintenance_work_order",resourceId:input.issueId,propertyScopeId:issue.row.propertyId,after:{returned:items.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const check of checks)await check();await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx)||jsonbFingerprint(rows)!==jsonbFingerprint(await repository.candidates(issue.row.propertyId,input.query,before)))throw new WorkOrderConflictError();
  return workOrderTaskChoicesSchema.parse({authorizationStamp:stamp,items,next:rows.length>20?maintenanceSourceCursor(actor,filter,rows[19].id):null});
 });
}
export async function readIssueWorkOrders(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const actor=capture(context),input=z.object({issueId:z.uuid(),cursor:z.string().max(6000).optional()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),repository=new WorkOrderRepository(tx,actor.organizationId),filter=jsonbFingerprint({purpose:"MAINTENANCE_ISSUE_WORK_ORDERS",issueId:input.issueId,stamp,held:authorizationScopeStamp(actor.authContext)}),before=readMaintenanceSourceCursor(actor,filter,input.cursor),rows=await repository.forIssue(input.issueId,before),items=[],checks:Array<()=>Promise<void>>=[];
  for(const row of rows.slice(0,20)){try{const source=await nativeMaintenanceWorkOrderTask(actor,tx,row.id);items.push({state:"VISIBLE"as const,task:source.data,registeredAt:row.createdAt.toISOString()});checks.push(source.recheck);}catch(error){if(!(error instanceof WorkOrderAccessError))throw error;items.push({state:"MASKED"as const});}}
  let canRegister=false;try{await nativeMaintenanceIssue(actor,tx,input.issueId,"edit");canRegister=true;}catch(error){if(!(error instanceof MaintenanceIssueAccessError))throw error;}
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.list.read",resourceType:"maintenance_work_order",resourceId:input.issueId,propertyScopeId:issue.row.propertyId,after:{returned:items.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const check of checks)await check();await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx)||jsonbFingerprint(rows)!==jsonbFingerprint(await repository.forIssue(input.issueId,before)))throw new WorkOrderConflictError();
  return workOrderListSchema.parse({authorizationStamp:stamp,propertyId:issue.row.propertyId,canRegister,items,next:rows.length>20?maintenanceSourceCursor(actor,filter,rows[19].id):null});
 });
}
