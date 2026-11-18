import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {maintenanceAuthorityStamp} from "@/platform/maintenance/issue-sources";
import {inspectWorkOrderExpense} from "@/platform/maintenance/work-order-expense-source";
import {WorkOrderRepository} from "../infrastructure/work-order-repository";
import {WorkOrderAccessError,WorkOrderConflictError} from "../domain/work-order";
import {workOrderExpenseSelectionSchema} from "../domain/work-order-finance";

export async function previewWorkOrderExpense(context:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new WorkOrderAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=workOrderExpenseSelectionSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),source=await inspectWorkOrderExpense(actor,tx,input),now=await new WorkOrderRepository(tx,actor.organizationId).clock();
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.work_order.expense.reviewed",resourceType:"maintenance_work_order",resourceId:input.taskId,propertyScopeId:source.expense.propertyId,after:{sourceType:"EXPENSE"},requestId:deps.requestId??randomUUID(),occurredAt:now});
  await source.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new WorkOrderConflictError();
  return{authorizationStamp:stamp,taskId:input.taskId,expense:source.expense,sourceFingerprint:source.fingerprint};
 });
}
