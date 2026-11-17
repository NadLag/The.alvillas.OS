import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Action,AuthContext,Resource} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {serviceOrderPolicyKey,serviceOrderPolicySchema} from "@/platform/config/service-order-policy";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeServiceOrderProperty,nativeServiceOrderReservation,nativeServicePickupTimezone} from "@/platform/services/order-source";
import {nativeServiceCatalogCurrency} from "@/platform/services/catalog-provider-source";
import {serviceCatalogRuleKey} from "@/platform/config/service-catalog-policy";
import {ServiceOrderRepository} from "../infrastructure/service-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderConfigurationError,ServiceOrderSourceUnavailableError,priceServiceOrder,type ServiceOrderRequest} from "../domain/service-order";
import {readNativeServiceCatalog,serviceCatalogTermsSources} from "./service-catalog-source";

type Identity={propertyId:string;reservationId:string;serviceKey?:string;id?:string;state?:string;createdAt?:Date};
type NativeMetadata={property:NonNullable<Awaited<ReturnType<typeof nativeServiceOrderProperty>>>;reservation:NonNullable<Awaited<ReturnType<typeof nativeServiceOrderReservation>>>;stored:AuthContext;now:Date};
export async function serviceOrderPropertyAuthority(actor:AccountActorContext,tx:TenantTransaction,propertyId:string){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),[property,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);if(!property)throw new ServiceOrderAccessError();
 const scope={organizationId:actor.organizationId,propertyId:property.id,city:property.cityId,region:property.regionId},checks:CurrentAuthorityCheck[]=[{action:"view",resource:{...scope,type:"property",id:property.id,status:property.status,occurredAt:property.createdAt}},{action:"view",resource:{...scope,type:"service_order",dataClass:"operational"}}];
 assertAccountAuthorization(actor,stored,now,checks,new ServiceOrderAccessError());return{repository,property,stored,now,scope,checks};
}
/** Metadata remains independently readable without disclosing catalog prices,
 * internal costs, provider labels, financial rules or private reasons. */
export async function serviceOrderAuthority(actor:AccountActorContext,tx:TenantTransaction,input:Identity,action:Action="view"){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),[property,reservation,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,input.propertyId),nativeServiceOrderReservation(tx,actor.organizationId,input.reservationId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);
 if(!property||!reservation||reservation.propertyId!==property.id)throw new ServiceOrderAccessError();
 return{repository,...serviceOrderMetadataAuthority(actor,input,{property,reservation,stored,now},action)};
}
/** Single-record and bounded page reads share the same actual source facts
 * and deny-by-default authority checks without per-row account queries. */
export function serviceOrderMetadataAuthority(actor:AccountActorContext,input:Identity,native:NativeMetadata,action:Action="view"){
 const{property,reservation,stored,now}=native;if(property.id!==input.propertyId||reservation.id!==input.reservationId||reservation.propertyId!==property.id)throw new ServiceOrderAccessError();
 const scope={organizationId:actor.organizationId,propertyId:property.id,reservationId:reservation.id,city:property.cityId,region:property.regionId},resource:Resource={...scope,type:"service_order",id:input.id,serviceId:input.serviceKey,status:input.state,occurredAt:input.createdAt,dataClass:"operational"},checks:CurrentAuthorityCheck[]=[
  {action:"view",resource:{...scope,type:"property",id:property.id,status:property.status,occurredAt:property.createdAt}},
  {action:"view",resource:{...scope,type:"reservation",id:reservation.id,status:reservation.status,occurredAt:reservation.createdAt,dataClass:"guest"}},
  ...input.serviceKey?[{action:"view"as const,resource:{...scope,type:"service",id:input.serviceKey,serviceId:input.serviceKey}}]:[],
  {action,resource}
 ];
 assertAccountAuthorization(actor,stored,now,checks,new ServiceOrderAccessError());
 return{property,reservation,stored,now,scope,resource,checks,fingerprint:commandFingerprint({property,reservation,held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
}

/** The actual booking source participates in the existing precedence resolver;
 * no request can substitute a different property's or channel's catalog. */
export async function inspectNewServiceOrder(actor:AccountActorContext,tx:TenantTransaction,request:ServiceOrderRequest){
 const authority=await serviceOrderAuthority(actor,tx,{...request});
 if(authority.property.archivedAt||authority.reservation.archivedAt)throw new ServiceOrderSourceUnavailableError();
 const catalog=await readNativeServiceCatalog(actor,tx,{propertyId:authority.property.id,source:authority.reservation.source}),entry=catalog.catalog?.services.find(item=>item.key===request.serviceKey);
 if(!catalog.rule||!entry)throw new ServiceOrderConfigurationError();
 const rules=new ConfigRuleRepository(tx,actor.organizationId),policy=await rules.resolveMetadata({key:serviceOrderPolicyKey,scopes:catalog.scopes,asOf:authority.now}),head=policy?await rules.sourceMetadataWitness(policy.id):null;
 if(!head||head.archivedAt||!head.createdBy)throw new ServiceOrderConfigurationError();
 const policyChecks:CurrentAuthorityCheck[]=["view","export"].map(verb=>({action:verb as "view"|"export",unconditional:true,resource:{...authority.scope,type:"config_rule",id:head.id,dataClass:"operational",occurredAt:head.createdAt}}));
 assertAccountAuthorization(actor,authority.stored,authority.now,policyChecks,new ServiceOrderAccessError());
 const policyValue=await rules.sourceWitness(head.id);if(!policyValue||policyValue.xmin!==head.xmin||policyValue.tuple!==head.tuple)throw new ServiceOrderConflictError();
 const priced=priceServiceOrder(request,entry,authority.reservation,authority.property,serviceOrderPolicySchema.parse(policyValue.value)),terms=await serviceCatalogTermsSources(actor,tx,catalog,[entry],true),currency=await nativeServiceCatalogCurrency(tx,actor.organizationId,entry.currency!);
 if(!currency||currency.minorUnit<0||currency.minorUnit>2||priced.price.kind==="PRICED"&&priced.price.amount.amount.decimalPlaces()>currency.minorUnit)throw new ServiceOrderConfigurationError();
 const checks:CurrentAuthorityCheck[]=[...authority.checks,...policyChecks,...catalog.checks,...terms.checks,{action:"create",resource:{...authority.resource,occurredAt:authority.now,amount:priced.price.kind==="PRICED"?priced.price.amount.amount.toFixed(2):undefined}}];
 assertAccountAuthorization(actor,authority.stored,authority.now,checks,new ServiceOrderAccessError());
 const pickupTimezone=request.transfer?await nativeServicePickupTimezone(tx,actor.organizationId,authority.property.id):null;if(request.transfer&&(!pickupTimezone||pickupTimezone.xmin!==authority.property.xmin||pickupTimezone.tuple!==authority.property.tuple))throw new ServiceOrderConflictError();
 const snapshot=Object.fromEntries(["key","name","description","available","pricing_model","amount","currency","order_terms"].filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]])),witnesses={catalogRule:catalog.witness,policyRule:head,property:{...authority.property,...pickupTimezone?{timezone:pickupTimezone.timezone}:{}},reservation:authority.reservation,financialFingerprint:terms.fingerprint,currency};
 return{...authority,...priced,catalog,entry,currency,snapshot,witnesses,checks,reviewFingerprint:commandFingerprint({request,authority:authority.fingerprint,witnesses,catalogKey:serviceCatalogRuleKey,terms:terms.fingerprint})};
}
