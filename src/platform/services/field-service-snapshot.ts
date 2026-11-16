import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Resource} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {FieldPullError} from "@/modules/reservations/application/field-pull-cursor";
import {FieldPullRepository} from "@/modules/reservations/infrastructure/field-pull-repository";
import type {FieldPullInput} from "@/modules/reservations/domain/field-pull";
import {taskResource} from "@/platform/authz/task-resource";
/** One indexed projection for the authorized page, independent of task count.
 * Current authority is checked again before publishing the offline snapshot. */
export async function fieldServiceSnapshots<Row extends{taskId:string;propertyId:string;reservationId?:string|null},Value>(tx:TenantTransaction,actor:AccountActorContext,resources:readonly Resource[],mode:FieldPullInput["mode"],load:(ids:string[])=>Promise<Row[]>,project:(row:Row)=>Value){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),targets=[...new Map(resources.filter(row=>row.id).map(row=>[row.id!,row])).values()],items=new Map<string,Value>();
 async function recheck(){
  if(!targets.length)return;const [stored,now]=await Promise.all([authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);
  const rows=await new FieldPullRepository(tx,actor.organizationId).known(actor.actorId,actor.authContext,now,targets.map(row=>row.id!),mode);
  if(rows.length!==targets.length)throw new FieldPullError("forbidden");
  const checks=rows.flatMap(row=>{const previous=targets.find(target=>target.id===row.id)!,resource={...previous,...taskResource({...row,organizationId:actor.organizationId}),reservationId:row.reservationId??undefined};if(resource.propertyId!==previous.propertyId||resource.reservationId!==previous.reservationId||resource.assignedPersonId!==previous.assignedPersonId||resource.assignedUserAccountId!==previous.assignedUserAccountId||resource.status!==previous.status)throw new FieldPullError("forbidden");return[{action:"view" as const,resource},...(mode==="supervised"?[{action:"validate" as const,resource}]:[])];});
  assertAccountAuthorization(actor,stored,now,checks,new FieldPullError("forbidden"));
 }
 await recheck();
 for(const row of await load(targets.map(row=>row.id!))){const resource=targets.find(target=>target.id===row.taskId);if(!resource||resource.propertyId!==row.propertyId||row.reservationId!==undefined&&row.reservationId!==resource.reservationId)throw new FieldPullError("forbidden");items.set(row.taskId,project(row));}
 return{items,recheck};
}
