import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {AuthContext} from "@/platform/authz/authorize";
import {taskResource} from "@/platform/authz/task-resource";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {EmployeeCompensationRepository} from "@/modules/finance/infrastructure/employee-compensation-repository";
import {validateEmployeeCompletedWorkEvidence} from "@/modules/finance/application/employee-compensation-source";
import {ServiceOrderAccessError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";

/** Fulfillment comes from actual native operation history. An order state,
 * current assignee or browser acknowledgement never substitutes for work. */
export async function nativeServiceOrderWork(actor:AccountActorContext,tx:TenantTransaction,order:{propertyId:string;reservationId:string;taskId:string|null},stored:AuthContext,now:Date){
 if(!order.taskId)return{task:null,started:false,completed:false,completionEventId:null,checks:[]as CurrentAuthorityCheck[],fingerprint:commandFingerprint({task:null})};
 const repository=new OperationRepository(tx,actor.organizationId),task=await repository.serviceOrderTaskHead(order.taskId);
 if(!task||task.propertyId!==order.propertyId||task.reservationId!==order.reservationId)throw new ServiceOrderAccessError();
 const checks:CurrentAuthorityCheck[]=[{action:"view",resource:taskResource(task)}];assertAccountAuthorization(actor,stored,now,checks,new ServiceOrderAccessError());
 const start=await repository.serviceOrderTaskStart(task.id),snapshot=start?.after&&typeof start.after==="object"&&!Array.isArray(start.after)?start.after:null,
  started=!task.archivedAt&&task.state==="IN_PROGRESS"&&!!start?.actorId&&start.version<=task.version&&snapshot?.id===task.id&&snapshot.organization_id===actor.organizationId&&snapshot.property_id===order.propertyId&&snapshot.version===start.version;
 let completed=false,completionEventId:string|null=null,completion:unknown=null;
 if(!task.archivedAt&&task.state==="COMPLETED"){
  const work=await new EmployeeCompensationRepository(tx,actor.organizationId).completedWork(task.id);if(!work||work.propertyId!==order.propertyId)throw new ServiceOrderSourceUnavailableError();
  try{const actual=validateEmployeeCompletedWorkEvidence(work);if(!work.completedAt||work.completedAt>now)throw new ServiceOrderSourceUnavailableError();completed=true;completionEventId=actual.event.id;completion=work;}catch{throw new ServiceOrderSourceUnavailableError();}
 }
 return{task,started,completed,completionEventId,checks,fingerprint:commandFingerprint({task,start,completion})};
}
