import {z} from "zod";
import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {authorizationScopeStamp} from "@/platform/authz/authority-stamp";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {nativeMaintenanceIssue,inspectMaintenanceIssueSource,maintenanceAuthorityStamp} from "@/platform/maintenance/issue-sources";
import {maintenanceSourceCursor,readMaintenanceSourceCursor} from "@/platform/maintenance/source-cursor";
import {MaintenanceIssueContextRepository} from "../infrastructure/issue-context-repository";
import {maintenanceIssueSourceSchema,MaintenanceIssueAccessError,MaintenanceIssueConflictError,MaintenanceIssueSourceUnavailableError} from "../domain/issue-context";

const inputSchema=z.object({issueId:z.uuid(),kind:z.enum(["PROPERTY","RESERVATION","GUEST","TASK","PERSON","SUPPLIER","EXPENSE","ASSET","PHOTO","DOCUMENT"]),provider:z.enum(["DOCUMENT_VERSION","FIELD_EVIDENCE"]).optional(),query:z.string().trim().max(120).default(""),cursor:z.string().max(6000).optional()}).strict().superRefine((value,context)=>{if(value.provider&&(value.kind!=="PHOTO"&&value.kind!=="DOCUMENT"||value.kind==="DOCUMENT"&&value.provider!=="DOCUMENT_VERSION"))context.addIssue({code:"custom",message:"Retain the original evidence provider"});});
type Dependencies={db?:TenantTransactionRunner;requestId?:string};
/** Canonical source metadata is bounded before original per-record authority.
 * Private source labels are never disclosed as a consequence of issue access. */
export async function maintenanceIssueSourceChoices(context:AccountActorContext,raw:unknown,deps:Dependencies={}){
 if(context.actorId!==context.authContext.userAccountId||context.organizationId!==context.authContext.organizationId)throw new MaintenanceIssueAccessError();
 const actor={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=inputSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const stamp=await maintenanceAuthorityStamp(actor,tx),issue=await nativeMaintenanceIssue(actor,tx,input.issueId),repository=new MaintenanceIssueContextRepository(tx,actor.organizationId),filter=jsonbFingerprint({purpose:"MAINTENANCE_SOURCE",issueId:input.issueId,kind:input.kind,provider:input.provider??null,query:input.query,stamp,held:authorizationScopeStamp(actor.authContext)}),before=readMaintenanceSourceCursor(actor,filter,input.cursor),candidateInput={kind:input.kind,...input.provider?{provider:input.provider}:{},query:input.query,propertyId:issue.context.propertyId,...before?{before}:{}},rows=await repository.candidates(candidateInput),items=[],checks:Array<()=>Promise<void>>=[];
  for(const row of rows.slice(0,20)){
   const reference=maintenanceIssueSourceSchema.parse({kind:input.kind,id:row.id,...input.kind==="PHOTO"||input.kind==="DOCUMENT"?{provider:input.provider??"DOCUMENT_VERSION"}:{}});
   try{const source=await inspectMaintenanceIssueSource(actor,tx,reference,issue.context);items.push({reference:source.reference,label:source.label,dataClass:source.dataClass,...source.labels?{labels:source.labels}:{},...source.navigation?{navigation:source.navigation}:{}});checks.push(source.recheck);}
   catch(error){if(!(error instanceof MaintenanceIssueAccessError||error instanceof MaintenanceIssueSourceUnavailableError))throw error;}
  }
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"maintenance.issue.sources.read",resourceType:"maintenance_issue_context",resourceId:input.issueId,propertyScopeId:issue.row.propertyId,after:{sourceKind:input.kind,returned:items.length},requestId:deps.requestId??randomUUID(),occurredAt:issue.now});
  for(const check of checks)await check();await issue.recheck();if(stamp!==await maintenanceAuthorityStamp(actor,tx)||jsonbFingerprint(rows)!==jsonbFingerprint(await repository.candidates(candidateInput)))throw new MaintenanceIssueConflictError();
  return{authorizationStamp:stamp,ready:input.kind!=="ASSET",items,next:rows.length>20?maintenanceSourceCursor(actor,filter,rows[19].id):null};
 });
}
