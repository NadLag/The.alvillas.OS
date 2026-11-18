import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeMaintenanceIssue,inspectMaintenanceIssueSource,maintenanceAuthorityStamp,type MaintenanceAssetSource} from "@/platform/maintenance/issue-sources";
import {MaintenanceIssueContextRepository} from "../infrastructure/issue-context-repository";
import {maintenanceIssueLinkReceiptSchema,MaintenanceIssueAccessError,MaintenanceIssueConflictError,MaintenanceIssueSourceUnavailableError} from "../domain/issue-context";
import {maintenanceIssueHistorySchema} from "../domain/issue-context-view";

type Dependencies={db?:TenantTransactionRunner;requestId?:string;assets?:MaintenanceAssetSource};
export async function readMaintenanceIssueHistory(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=z.object({issueId:z.uuid(),before:z.string().regex(/^[1-9]\d{0,18}$/u).refine(value=>/^[1-9]\d{0,18}$/u.test(value)&&BigInt(value)<=9223372036854775807n).optional()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),repository=new MaintenanceIssueContextRepository(tx,actor.organizationId),audit:CurrentAuthorityCheck[]=[{action:"view",resource:{type:"audit_log",organizationId:actor.organizationId,propertyId:issue.row.propertyId,city:issue.row.task.property.cityId??issue.row.task.property.city,region:issue.row.task.property.regionId??issue.row.task.property.region,dataClass:"operational"}}];
  await recheckAccountAuthorization(actor,tx,issue.now,audit,new MaintenanceIssueAccessError());
  const rows=await repository.history(input.issueId,input.before),items=[],checks:Array<()=>Promise<void>>=[];
  for(const row of rows.slice(0,20)){
   const receipt=maintenanceIssueLinkReceiptSchema.parse(await repository.original(row.id));if(receipt.intent.issueId!==input.issueId||receipt.contextId!==row.id||receipt.version!==row.version)throw new MaintenanceIssueConflictError();
   const base={id:row.id,version:row.version,operation:row.operation,kind:receipt.intent.source.kind,createdAt:row.createdAt.toISOString(),actor:row.actorId===actor.actorId?"SELF" as const:"OTHER" as const};
   try{const source=await inspectMaintenanceIssueSource(actor,tx,receipt.intent.source,issue.context,deps.assets);items.push({...base,detail:{reference:source.reference,label:source.label,reason:row.reason,dataClass:source.dataClass,...source.labels?{labels:source.labels}:{},...source.navigation?{navigation:source.navigation}:{}}});checks.push(source.recheck);}
   catch(error){if(!(error instanceof MaintenanceIssueAccessError||error instanceof MaintenanceIssueSourceUnavailableError))throw error;items.push({...base,detail:null});}
  }
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.history.read",resourceType:"maintenance_issue_context",resourceId:input.issueId,propertyScopeId:issue.row.propertyId,after:{returned:items.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const check of checks)await check();const finalIssue=await nativeMaintenanceIssue(actor,tx,input.issueId);await recheckAccountAuthorization(actor,tx,finalIssue.now,audit,new MaintenanceIssueAccessError());
  if(finalIssue.fingerprint!==issue.fingerprint||stamp!==await maintenanceAuthorityStamp(actor,tx)||jsonbFingerprint(rows)!==jsonbFingerprint(await repository.history(input.issueId,input.before)))throw new MaintenanceIssueConflictError();
  return maintenanceIssueHistorySchema.parse({authorizationStamp:stamp,items,next:rows.length>20?rows[19].version:null});
 });
}
