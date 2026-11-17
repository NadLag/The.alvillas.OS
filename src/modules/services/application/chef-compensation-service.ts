import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {present} from "@/platform/authz/present";
import {randomUUID} from "node:crypto";
import {nativeChefCompensationContext} from "@/platform/services/chef-compensation-source";
import {chefCompensationRequestSchema,chefCompensationContextSchema} from "../domain/chef-compensation";
export async function readChefCompensationContext(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}){
 const input=chefCompensationRequestSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const source=await nativeChefCompensationContext(actor,tx,input.orderId);await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"service.chef.compensation_context_read",resourceType:"staff_compensation",resourceId:source.work.chefPersonId!,propertyScopeId:source.order.propertyId,after:{orderId:source.order.id,personId:source.work.chefPersonId},requestId:deps.requestId??randomUUID(),occurredAt:source.now});const current=await source.recheck(),value=chefCompensationContextSchema.parse({orderId:current.order.id,personId:current.work.chefPersonId,canConfigure:current.canConfigure,canViewPayables:current.canViewPayables});return present({...actor.authContext,visibleDataClasses:new Set(["financial"]as const)},"view",{...current.resource,data:value},Object.fromEntries(Object.keys(value).map(key=>[key,{dataClass:"financial"as const}])),current.now);});
}
