import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {nativeTransferTask} from "@/platform/services/transfer-task-source";
export async function readTransferTask(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}){const input=z.object({taskId:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,tx=>nativeTransferTask(actor,tx,input.taskId));}
