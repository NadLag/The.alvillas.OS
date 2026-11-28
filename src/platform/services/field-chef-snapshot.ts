import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Resource} from "@/platform/authz/authorize";
import type {FieldPullInput} from "@/modules/reservations/domain/field-pull";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {chefTaskRecipePayload} from "./chef-task-source";
import {fieldServiceSnapshots} from "./field-service-snapshot";
export function fieldChefSnapshots(tx:TenantTransaction,actor:AccountActorContext,resources:readonly Resource[],mode:FieldPullInput["mode"]){const repository=new ServiceOrderRepository(tx,actor.organizationId);return fieldServiceSnapshots(tx,actor,resources,mode,ids=>repository.chefTaskRecipes(ids),chefTaskRecipePayload);}
