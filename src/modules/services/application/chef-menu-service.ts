import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {inspectNativeChefTask} from "@/platform/services/chef-task-source";
import {chefTaskRequestSchema} from "../domain/chef-menu-view";
export function readChefTaskRecipe(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}){
 const input=chefTaskRequestSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,tx=>inspectNativeChefTask(actor,tx,input.taskId),{timeout:120000});
}
