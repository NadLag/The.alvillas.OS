import { readAssetSource } from "@/modules/assets/application/asset-service";
import { AssetAccessError, AssetConflictError } from "@/modules/assets/domain/asset";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {assignmentCandidates} from "@/platform/authz/authorize";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {taskResource} from "@/platform/authz/task-resource";
import {authorizationScopeStamp} from "@/platform/authz/authority-stamp";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {localizedTextSchema} from "@/i18n/content";
import type {z} from "zod";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentArchiveContext} from "@/modules/documents/application/document-archive";
import {documentSourceReferenceSchema,DocumentAccessError} from "@/modules/documents/domain/document-command";
import {IdentityRepository} from "@/modules/identity/infrastructure/identity-repository";
import {ExpenseRepository} from "@/modules/finance/infrastructure/expense-repository";
import {getExpense,ExpenseAccessError} from "@/modules/finance/application/expense-service";
import {MaintenanceIssueAccessError,MaintenanceIssueConflictError,maintenanceIssueSourceSchema,type MaintenanceIssueSource} from "@/modules/maintenance/domain/issue-context";

export type MaintenanceSourceContext={propertyId:string;taskId:string};
export type MaintenanceSourceNavigation={kind:"FIELD_EVIDENCE";id:string}|{kind:"DOCUMENT_VERSION";documentId:string;version:number}|{kind:"ASSET";id:string};
export type AuthorizedMaintenanceSource={reference:MaintenanceIssueSource;label:string;labels?:z.infer<typeof localizedTextSchema>;dataClass:"operational"|"personal"|"guest"|"financial"|"sensitive";navigation?:MaintenanceSourceNavigation;fingerprint:string;checks:CurrentAuthorityCheck[];recheck:()=>Promise<void>};
export type MaintenanceAssetSource=(actor:AccountActorContext,tx:TenantTransaction,reference:Extract<MaintenanceIssueSource,{kind:string}>,context:MaintenanceSourceContext)=>Promise<AuthorizedMaintenanceSource>;
const digest=(value:unknown)=>jsonbFingerprint(JSON.parse(JSON.stringify(value)));
async function clock(tx:TenantTransaction,organizationId:string){return new DocumentRepository(tx,organizationId).clock();}
function sameProperty(actual:string|undefined|null,context:MaintenanceSourceContext){if(actual&&actual!==context.propertyId)throw new MaintenanceIssueAccessError();}

/** The original operational issue and task remain the sole intake records. */
export async function nativeMaintenanceIssue(actor:AccountActorContext,tx:TenantTransaction,id:string,action:"view"|"edit"="view"){
 const read=async()=>{
  const row=await new OperationRepository(tx,actor.organizationId).maintenanceIssue(id);
  if(!row||row.task.archivedAt||row.task.property.archivedAt||row.propertyId!==row.task.propertyId)throw new MaintenanceIssueAccessError();
  const task={...taskResource(row.task),dataClass:"operational" as const},resource={...task,type:"issue",id:row.id,status:row.state},checks:CurrentAuthorityCheck[]=[{action:"view",resource:task},{action:"view",resource},{action,resource},{action:"view",resource:{...task,type:"property",id:row.propertyId}}];
  const now=await clock(tx,actor.organizationId);
  await recheckAccountAuthorization(actor,tx,now,checks,new MaintenanceIssueAccessError());
  return{row,checks,now,fingerprint:digest({issue:row,task})};
 };
 const first=await read();return{...first,context:{taskId:first.row.taskId,propertyId:first.row.propertyId},recheck:async()=>{if((await read()).fingerprint!==first.fingerprint)throw new MaintenanceIssueConflictError();}};
}

/** Every label is read through its original authority. Financial source values
 * are never copied into an operational issue or used to create a second cost. */
export async function inspectMaintenanceIssueSource(actor:AccountActorContext,tx:TenantTransaction,raw:unknown,context:MaintenanceSourceContext,assets?:MaintenanceAssetSource):Promise<AuthorizedMaintenanceSource>{
 const reference=maintenanceIssueSourceSchema.parse(raw);
 if(reference.kind==="ASSET"){
  if (assets) return assets(actor,tx,reference,context);
  const translate = (error: unknown): never => {
    if (error instanceof AssetAccessError) throw new MaintenanceIssueAccessError();
    if (error instanceof AssetConflictError) throw new MaintenanceIssueConflictError();
    throw error;
  };
  try {
    const source = await readAssetSource(actor, tx, reference.id, context.propertyId);
    return { reference, label: source.label, dataClass: "operational", navigation: { kind: "ASSET", id: source.id },
      fingerprint: jsonbFingerprint({ id: source.id, revisionId: source.revisionId }), checks: source.checks,
      recheck: async () => { try { await source.recheck(); } catch (error) { translate(error); } } };
  } catch (error) { return translate(error); }
 }
 const read=async()=>{
  const documents=new DocumentRepository(tx,actor.organizationId);
  let label:string,labels:AuthorizedMaintenanceSource["labels"],dataClass:AuthorizedMaintenanceSource["dataClass"],snapshot:unknown,navigation:MaintenanceSourceNavigation|undefined,checks:CurrentAuthorityCheck[]=[];
  if(reference.kind==="TASK"){
   const task=await new OperationRepository(tx,actor.organizationId).task(reference.id);if(!task)throw new MaintenanceIssueAccessError();sameProperty(task.propertyId,context);
   const resource={...taskResource(task),dataClass:"operational" as const};checks=[{action:"view",resource}];label=task.type;const title=localizedTextSchema.safeParse(task.titleTranslations);if(title.success)labels=title.data;dataClass="operational";snapshot=task;
  }else if(reference.kind==="PERSON"){
   const person=await new IdentityRepository(tx,actor.organizationId).maintenancePerson(reference.id);if(!person||person.archivedAt)throw new MaintenanceIssueAccessError();
   checks=[{action:"view",organizationOnly:true,resource:{type:"team_member",organizationId:actor.organizationId,id:person.id,assignedPersonId:person.id,dataClass:"personal"}}];label=person.displayName;dataClass="personal";snapshot=person;
  }else if(reference.kind==="EXPENSE"){
   // The original finance service checks held/current owner, source, wallet and
   // attachment rules before any private financial label can leave this bridge.
   await getExpense(actor,reference.id,{db:{$transaction:async work=>work(tx)}});
   const expense=await new ExpenseRepository(tx,actor.organizationId).find(reference.id);if(!expense)throw new MaintenanceIssueAccessError();sameProperty(expense.propertyId,context);
   label=expense.purpose;dataClass="financial";snapshot={id:expense.id,version:expense.version,state:expense.state,propertyId:expense.propertyId,reservationId:expense.reservationId};
  }else if(reference.kind==="DOCUMENT"||reference.kind==="PHOTO"){
   if(reference.provider==="FIELD_EVIDENCE"){
    const operations=new OperationRepository(tx,actor.organizationId),evidence=await operations.evidenceById(reference.id),task=evidence?await operations.task(evidence.taskId):null;
    if(!evidence||!task||!evidence.contentType||!evidence.storageKey||!evidence.sha256||!["image/png","image/jpeg","image/webp"].includes(evidence.contentType))throw new MaintenanceIssueAccessError();sameProperty(task.propertyId,context);
    checks=[{action:"view",resource:{...taskResource(task),dataClass:"operational"}}];label=evidence.note||evidence.id;dataClass="operational";snapshot={evidence,task};navigation={kind:"FIELD_EVIDENCE",id:evidence.id};
   }else{
    const version=await documents.version(reference.id),root=version?await documents.document(version.documentId):null;
    if(!version||!root||root.archivedAt||reference.kind==="DOCUMENT"&&!['FILE','INSTANCE'].includes(root.kind)||reference.kind==="PHOTO"&&(root.kind!=="FILE"||!["image/png","image/jpeg","image/webp"].includes(version.admission.contentType)))throw new MaintenanceIssueAccessError();
    const source=documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),archive=await documentArchiveContext(actor,tx,source,"view",root);sameProperty(archive.native.resource.propertyId,context);
    checks=archive.checks;label=version.title;dataClass=archive.privacy.includes("financial")||archive.native.resource.dataClass==="financial"?"financial":archive.privacy.includes("sensitive")?"sensitive":archive.native.resource.dataClass??"operational";snapshot={id:version.id,sha256:version.admission.sha256,source:archive.fingerprint};navigation={kind:"DOCUMENT_VERSION",documentId:root.id,version:version.number};
   }
  }else{
   if(reference.kind==="ASSET")throw new MaintenanceIssueAccessError();
   const native=await documents.documentSource({kind:reference.kind,id:reference.id});if(!native||native.archived)throw new MaintenanceIssueAccessError();sameProperty(native.resource.propertyId,context);
   checks=native.checks;label=native.label;dataClass=native.resource.dataClass??"operational";snapshot=native.fingerprint;
  }
  await recheckAccountAuthorization(actor,tx,await documents.clock(),checks,new MaintenanceIssueAccessError());
  return{reference,label,...labels?{labels}:{},dataClass,...navigation?{navigation}:{},checks,fingerprint:digest({reference,snapshot})};
 };
 try{const first=await read();return{...first,recheck:async()=>{try{if((await read()).fingerprint!==first.fingerprint)throw new MaintenanceIssueConflictError();}catch(error){if(error instanceof DocumentAccessError||error instanceof ExpenseAccessError)throw new MaintenanceIssueAccessError();throw error;}}};}
 catch(error){if(error instanceof DocumentAccessError||error instanceof ExpenseAccessError)throw new MaintenanceIssueAccessError();throw error;}
}

/** An account change anywhere during a graph read invalidates the whole view,
 * including sources whose native authority was checked earlier in the read. */
export async function maintenanceAuthorityStamp(actor:AccountActorContext,tx:TenantTransaction){
 const current={...await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),personId:actor.authContext.personId},now=await clock(tx,actor.organizationId);
 const transitions=[...assignmentCandidates(current),...assignmentCandidates(actor.authContext)].flatMap(grant=>[grant.validFrom,grant.validTo,grant.conditions?.timeWindow?.startsAt,grant.conditions?.timeWindow?.endsAt]).filter((value):value is Date|string=>Boolean(value)).map(value=>new Date(value).getTime()).filter(value=>Number.isFinite(value)&&value<=now.getTime());
 return jsonbFingerprint({current:authorizationScopeStamp(current),transition:transitions.reduce((latest,value)=>Math.max(latest,value),0)});
}
