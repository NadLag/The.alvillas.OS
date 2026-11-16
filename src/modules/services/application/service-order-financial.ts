import {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {nativeServiceOrderFinancialPage} from "@/platform/services/order-financial-read";
const input=z.object({orderId:z.uuid(),after:z.uuid().optional()}).strict();
export async function serviceOrderFinancialPage(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId:string}){
 const selection=input.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,tx=>nativeServiceOrderFinancialPage(actor,tx,selection),{timeout:120000});
}
