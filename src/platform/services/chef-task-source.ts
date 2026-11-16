import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {taskResource} from "@/platform/authz/task-resource";
import {present} from "@/platform/authz/present";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {ServiceOrderRepository,type ChefRecipeRecord} from "@/modules/services/infrastructure/service-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
import {chefTaskResponseSchema} from "@/modules/services/domain/chef-menu-view";
import {servicePricedUnits} from "./priced-units";
import {recipeQuantity,recipeQuantityString} from "./recipe-quantity";
export function chefTaskRecipePayload(row:ChefRecipeRecord){const value=chefTaskResponseSchema.parse({taskId:row.taskId,orderId:row.orderId,propertyId:row.propertyId,name:row.name,description:row.description,quantity:Number(row.quantity),guests:row.guests,serviceDate:row.serviceDate,lastServiceDate:row.lastServiceDate,menu:row.menu}),units=servicePricedUnits(row.pricingModel,row.dimensions);return{...value,requirements:{servings:(units*BigInt(value.menu.serving_quantity)).toString(),ingredients:value.menu.ingredients.map(item=>({...item,quantity:recipeQuantityString(recipeQuantity(item.quantity,units))}))}};}

/** Assigned work authority precedes a SQL projection of operational recipe
 * fields. Neither financial catalog access nor private guest data is needed. */
export async function inspectNativeChefTask(actor:AccountActorContext,tx:TenantTransaction,taskId:string){
 const orders=new ServiceOrderRepository(tx,actor.organizationId),operations=new OperationRepository(tx,actor.organizationId);
 async function read(){
  const [task,stored,now]=await Promise.all([operations.serviceOrderTaskHead(taskId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),orders.clock()]);
  if(!task||task.archivedAt)throw new ServiceOrderAccessError();
  const resource=taskResource(task);assertAccountAuthorization(actor,stored,now,[{action:"view",resource}],new ServiceOrderAccessError());
  const order=await orders.byTaskHead(task.id);if(!order||order.propertyId!==task.propertyId||order.reservationId!==task.reservationId)throw new ServiceOrderSourceUnavailableError();
  const recipe=await orders.chefTaskRecipe(order.id);if(!recipe?.menu)throw new ServiceOrderSourceUnavailableError();
  const value=chefTaskRecipePayload(recipe);if(value.taskId!==task.id||value.propertyId!==task.propertyId||value.orderId!==order.id)throw new ServiceOrderSourceUnavailableError();
  return{value:present({...actor.authContext,visibleDataClasses:new Set(["operational"] as const)},"view",{...resource,data:value},{menu:{dataClass:"operational"}},now),fingerprint:commandFingerprint({task,order:{...order,quantity:order.quantity.toString()},recipe})};
 }
 const before=await read(),after=await read();if(before.fingerprint!==after.fingerprint)throw new ServiceOrderConflictError();return after.value;
}
