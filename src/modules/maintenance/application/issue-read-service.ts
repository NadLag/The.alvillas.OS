import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeMaintenanceIssue,inspectMaintenanceIssueSource,maintenanceAuthorityStamp,type MaintenanceAssetSource} from "@/platform/maintenance/issue-sources";
import {MaintenanceIssueContextRepository} from "../infrastructure/issue-context-repository";
import {maintenanceIssueSourceSchema,MaintenanceIssueAccessError,MaintenanceIssueConflictError,MaintenanceIssueSourceUnavailableError} from "../domain/issue-context";
import {maintenanceIssueViewSchema} from "../domain/issue-context-view";

type Dependencies={db?:TenantTransactionRunner;requestId?:string;assets?:MaintenanceAssetSource};
export async function assertMaintenanceIssueViewer(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=z.object({issueId:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{await nativeMaintenanceIssue(actor,tx,input.issueId);});
}
/** A linked private record never turns operational issue access into financial,
 * guest or personnel access. Unavailable links retain a masked history marker. */
export async function readMaintenanceIssue(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=z.object({issueId:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),repository=new MaintenanceIssueContextRepository(tx,actor.organizationId),latest=await repository.latest(input.issueId),active=await repository.active(input.issueId),sources=[],checks:Array<()=>Promise<void>>=[];
  if(active.length>50)throw new MaintenanceIssueConflictError();
  for(const row of active){
   const reference=maintenanceIssueSourceSchema.parse(row.source);
   try{const source=await inspectMaintenanceIssueSource(actor,tx,reference,issue.context,deps.assets);sources.push({state:"VISIBLE" as const,contextId:row.id,reference,label:source.label,dataClass:source.dataClass,...source.labels?{labels:source.labels}:{},...source.navigation?{navigation:source.navigation}:{}});checks.push(source.recheck);}
   catch(error){if(!(error instanceof MaintenanceIssueAccessError||error instanceof MaintenanceIssueSourceUnavailableError))throw error;sources.push({state:"MASKED" as const,contextId:row.id,kind:reference.kind});}
  }
  let edit=false;try{await nativeMaintenanceIssue(actor,tx,input.issueId,"edit");edit=true;}catch(error){if(!(error instanceof MaintenanceIssueAccessError))throw error;}
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.context.read",resourceType:"maintenance_issue_context",resourceId:input.issueId,propertyScopeId:issue.row.propertyId,after:{sourceCount:sources.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const check of checks)await check();await issue.recheck();
  if(stamp!==await maintenanceAuthorityStamp(actor,tx)||jsonbFingerprint(latest)!==jsonbFingerprint(await repository.latest(input.issueId))||jsonbFingerprint(active)!==jsonbFingerprint(await repository.active(input.issueId)))throw new MaintenanceIssueConflictError();
  return maintenanceIssueViewSchema.parse({authorizationStamp:stamp,issue:{id:issue.row.id,taskId:issue.row.taskId,propertyId:issue.row.propertyId,title:issue.row.title,description:issue.row.description,severity:issue.row.severity,state:issue.row.state,evidenceId:issue.row.evidenceId},version:latest?.version??"0",capabilities:{edit},sources});
 });
}
