import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Resource} from "@/platform/authz/authorize";
import type {FieldPullInput} from "@/modules/reservations/domain/field-pull";
import {TransferOrderRepository} from "@/modules/services/infrastructure/transfer-order-repository";
import {transferTaskDetailsSchema} from "./transfer-task-contracts";
import {fieldServiceSnapshots} from "./field-service-snapshot";
export function fieldTransferSnapshots(tx:TenantTransaction,actor:AccountActorContext,resources:readonly Resource[],mode:FieldPullInput["mode"]){const repository=new TransferOrderRepository(tx,actor.organizationId);return fieldServiceSnapshots(tx,actor,resources,mode,ids=>repository.taskRequests(ids),row=>transferTaskDetailsSchema.parse({available:true,taskId:row.taskId,orderId:row.orderId,propertyId:row.propertyId,name:row.name,date:row.date,timezone:row.timezone,guests:row.guests,transfer:row.transfer}));}
