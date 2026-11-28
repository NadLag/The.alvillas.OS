import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {taskResource} from "@/platform/authz/task-resource";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {GroceryOrderRepository} from "@/modules/services/infrastructure/grocery-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError} from "@/modules/services/domain/service-order";
import {groceryTaskResponseSchema} from "./grocery-task-contracts";
export async function nativeGroceryTask(actor:AccountActorContext,tx:TenantTransaction,taskId:string){const operations=new OperationRepository(tx,actor.organizationId),orders=new ServiceOrderRepository(tx,actor.organizationId),groceries=new GroceryOrderRepository(tx,actor.organizationId);async function read(){const[task,stored,now]=await Promise.all([operations.serviceOrderTaskHead(taskId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),orders.clock()]);if(!task||task.archivedAt)throw new ServiceOrderAccessError();assertAccountAuthorization(actor,stored,now,[{action:"view",resource:taskResource(task)}],new ServiceOrderAccessError());const row=(await groceries.taskRecipes([task.id]))[0];if(row&&(row.propertyId!==task.propertyId||row.reservationId!==task.reservationId))throw new ServiceOrderAccessError();return{value:groceryTaskResponseSchema.parse(row?{available:true,taskId:row.taskId,orderId:row.orderId,propertyId:row.propertyId,taskType:row.taskType,name:row.name,items:row.items}:{available:false,taskId:task.id}),fingerprint:commandFingerprint({task,row})};}const before=await read(),after=await read();if(before.fingerprint!==after.fingerprint)throw new ServiceOrderConflictError();return after.value;}
