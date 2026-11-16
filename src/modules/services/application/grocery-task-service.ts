import {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {nativeGroceryTask} from "@/platform/services/grocery-task-source";
export async function readGroceryTask(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}){const input=z.object({taskId:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,tx=>nativeGroceryTask(actor,tx,input.taskId));}
