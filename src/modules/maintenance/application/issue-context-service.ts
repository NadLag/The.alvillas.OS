import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeMaintenanceIssue,inspectMaintenanceIssueSource,maintenanceAuthorityStamp,type MaintenanceAssetSource} from "@/platform/maintenance/issue-sources";
import {maintenanceIssueSourcesSchema,MaintenanceIssueAccessError,MaintenanceIssueConflictError} from "../domain/issue-context";

type Dependencies={db?:TenantTransactionRunner;requestId?:string;assets?:MaintenanceAssetSource};
const inputSchema=z.object({issueId:z.uuid(),sources:maintenanceIssueSourcesSchema}).strict();

/** Read original context before the native issue-link command is admitted.
 * Operations access alone never reveals a guest, person, invoice or expense. */
export async function previewMaintenanceIssueContext(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=inputSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),sources=[];
  for(const reference of input.sources)sources.push(await inspectMaintenanceIssueSource(actor,tx,reference,issue.context,deps.assets));
  const fingerprint=jsonbFingerprint({issue:issue.fingerprint,sources:sources.map(source=>({reference:source.reference,fingerprint:source.fingerprint}))});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.context.previewed",resourceType:"maintenance_issue_context",resourceId:input.issueId,after:{sourceCount:sources.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const source of sources)await source.recheck();
  await issue.recheck();
  if(stamp!==await maintenanceAuthorityStamp(actor,tx))throw new MaintenanceIssueConflictError();
  return{issue:{id:issue.row.id,taskId:issue.row.taskId,propertyId:issue.row.propertyId,title:issue.row.title,description:issue.row.description,severity:issue.row.severity,state:issue.row.state},sources:sources.map(source=>({reference:source.reference,label:source.label,dataClass:source.dataClass})),reviewFingerprint:fingerprint};
 });
}
