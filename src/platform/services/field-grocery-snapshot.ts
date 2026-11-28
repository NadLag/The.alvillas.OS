import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Resource} from "@/platform/authz/authorize";
import type {FieldPullInput} from "@/modules/reservations/domain/field-pull";
import {GroceryOrderRepository} from "@/modules/services/infrastructure/grocery-order-repository";
import {groceryTaskDetailsSchema} from "./grocery-task-contracts";
import {fieldServiceSnapshots} from "./field-service-snapshot";
export function fieldGrocerySnapshots(tx:TenantTransaction,actor:AccountActorContext,resources:readonly Resource[],mode:FieldPullInput["mode"]){const repository=new GroceryOrderRepository(tx,actor.organizationId);return fieldServiceSnapshots(tx,actor,resources,mode,ids=>repository.taskRecipes(ids),row=>groceryTaskDetailsSchema.parse({available:true,taskId:row.taskId,orderId:row.orderId,propertyId:row.propertyId,taskType:row.taskType,name:row.name,items:row.items}));}
