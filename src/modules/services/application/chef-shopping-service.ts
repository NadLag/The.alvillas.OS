import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {present} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {randomUUID} from "node:crypto";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {servicePricedUnits} from "@/platform/services/priced-units";
import {nativeServiceOrderReservations} from "@/platform/services/order-source";
import {serviceOrderPropertyAuthority,serviceOrderMetadataAuthority} from "./service-order-source";
import {chefShoppingInputSchema,chefShoppingResponseSchema} from "../domain/chef-shopping";
import {chefShoppingRequirements} from "../domain/chef-shopping-requirements";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderValidationError} from "../domain/service-order";
/** Automatic requirements are a projection of sealed originals, never a
 * second catalog, stock balance or financial posting. Return the complete
 * authorized selection or fail explicitly when the transport bound is hit. */
export async function readChefShoppingList(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}){
 const input=chefShoppingInputSchema.parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  async function heads(){const authority=await serviceOrderPropertyAuthority(actor,tx,input.propertyId),rows=await authority.repository.chefRequirementHeads(input);if(rows.length>500)throw new ServiceOrderValidationError();const reservations=await nativeServiceOrderReservations(tx,actor.organizationId,rows.map(row=>row.reservationId)),byId=new Map(reservations.map(row=>[row.id,row])),allowed=rows.filter(row=>{const reservation=byId.get(row.reservationId);if(!reservation)return false;try{serviceOrderMetadataAuthority(actor,row,{...authority,reservation});return true;}catch(error){if(error instanceof ServiceOrderAccessError)return false;throw error;}});return{...authority,rows:allowed,fingerprint:commandFingerprint({property:authority.property,reservations,rows:allowed.map(row=>({...row,quantity:row.quantity.toString()}))})};}
  const before=await heads(),rows=await before.repository.chefRequirementRows(before.rows.map(row=>row.id)),items=chefShoppingRequirements(rows),byId=new Map(rows.map(row=>[row.orderId,row]));
  const orders=before.rows.map(head=>{const row=byId.get(head.id);if(!row)throw new ServiceOrderConflictError();const pricedUnits=servicePricedUnits(row.pricingModel,row.dimensions);return{id:head.id,name:head.titleTranslations,serviceDate:head.serviceDate.toISOString().slice(0,10),lastServiceDate:head.lastServiceDate.toISOString().slice(0,10),state:head.state,pricedUnits:pricedUnits.toString(),servings:(pricedUnits*BigInt(row.servingQuantity)).toString()};});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"service.chef.requirements_read",resourceType:"service_order",resourceId:input.propertyId,propertyScopeId:input.propertyId,after:{from:input.from,through:input.through,orderIds:orders.map(row=>row.id),ingredientCount:items.length},requestId:deps.requestId??randomUUID(),occurredAt:before.now});
  const after=await heads();if(before.fingerprint!==after.fingerprint)throw new ServiceOrderConflictError();
  const value=chefShoppingResponseSchema.parse({propertyId:input.propertyId,from:input.from,through:input.through,generatedAt:after.now.toISOString(),fingerprint:commandFingerprint({source:after.fingerprint,items,orders}),items,orders});
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>1048576)throw new ServiceOrderValidationError();
  return present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...after.scope,type:"service_order",data:value},Object.fromEntries(Object.keys(value).map(key=>[key,{dataClass:"operational"as const}])),after.now);
 },{timeout:120000});
}
