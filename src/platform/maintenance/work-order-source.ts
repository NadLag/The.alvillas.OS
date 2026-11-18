import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {taskResource} from "@/platform/authz/task-resource";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {workOrderTaskSchema,WorkOrderAccessError,WorkOrderConflictError} from "@/modules/maintenance/domain/work-order";

/** Assignment, priority, status, scheduling and completion remain native tasks. */
export async function nativeMaintenanceWorkOrderTask(actor:AccountActorContext,tx:TenantTransaction,taskId:string,action:"view"|"edit"|"assign"="view"){
 const read=async()=>{
  const repository=new OperationRepository(tx,actor.organizationId),task=await repository.task(taskId),property=task?await repository.property(task.propertyId):null;
  if(!task||!property||task.type!=="MAINTENANCE")throw new WorkOrderAccessError();
  const resource={...taskResource(task),dataClass:"operational"as const},checks:CurrentAuthorityCheck[]=[{action:"view",resource},{action,resource},{action:"view",resource:{...resource,type:"property",id:task.propertyId}}],now=await new DocumentRepository(tx,actor.organizationId).clock();
  await recheckAccountAuthorization(actor,tx,now,checks,new WorkOrderAccessError());
  const data=workOrderTaskSchema.parse({id:task.id,propertyId:task.propertyId,reservationId:task.reservationId,version:task.version,type:task.type,title:task.titleTranslations,priority:task.priority,state:task.state,dueDate:task.dueDate.toISOString().slice(0,10),assignedToMe:task.assignedToUserAccountId===actor.actorId||Boolean(actor.authContext.personId&&task.assignedToPersonId===actor.authContext.personId),completedAt:task.completedAt?.toISOString()??null});
  return{task,now,fingerprint:jsonbFingerprint(JSON.parse(JSON.stringify({task,property}))),data:workOrderTaskSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...resource,data},{},now))};
 };
 const first=await read();return{...first,recheck:async()=>{if(first.fingerprint!==(await read()).fingerprint)throw new WorkOrderConflictError();}};
}
