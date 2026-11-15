import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Action} from "@/platform/authz/authorize";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {serviceCatalogRuleKey,servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {nativeServiceCatalogCurrency} from "@/platform/services/catalog-provider-source";
import {Money} from "@/platform/money/money";
import {ServiceOrderRepository} from "../infrastructure/service-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderConfigurationError,serviceOrderRequestSchema} from "../domain/service-order";
import {serviceOrderAuthority} from "./service-order-source";
import {serviceCatalogTermsSources,type ServiceCatalogTermsContext} from "./service-catalog-source";

/** Original order values are independent of the current editable catalog.
 * Native metadata and every financial source precede private values. */
export async function inspectOriginalServiceOrder(actor:AccountActorContext,tx:TenantTransaction,id:string){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),selected=await repository.head(id);if(!selected)throw new ServiceOrderAccessError();
 const head=selected,authority=await serviceOrderAuthority(actor,tx,head),rules=new ConfigRuleRepository(tx,actor.organizationId),catalog=await rules.sourceMetadataWitness(head.catalogRuleId);
 if(!catalog||catalog.key!==serviceCatalogRuleKey||catalog.version!==head.catalogRuleVersion||!catalog.createdBy)throw new ServiceOrderConfigurationError();
 const financialChecks:CurrentAuthorityCheck[]=(["view","export"]as const).flatMap(action=>[
  {action,unconditional:true,resource:{...authority.scope,type:"config_rule",id:catalog.id,dataClass:"financial"as const,status:catalog.lifecycle,occurredAt:catalog.createdAt}},
  {action,unconditional:true,resource:{...authority.scope,type:"financial_transaction",dataClass:"financial"as const}}
 ]);
 assertAccountAuthorization(actor,authority.stored,authority.now,financialChecks,new ServiceOrderAccessError());
 const root=await repository.original(id);if(!root||root.version!==head.version||root.state!==head.state)throw new ServiceOrderConflictError();
 const entry=servicePricingSchema.shape.services.element.parse(root.catalogSnapshot),snapshot=root.requestSnapshot;
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))throw new ServiceOrderConfigurationError();
 const request=serviceOrderRequestSchema.parse(Object.fromEntries(Object.keys(serviceOrderRequestSchema.shape).map(key=>[key,snapshot[key]]))),
  scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:root.propertyId,source:authority.reservation.source,asOf:authority.now}),
  context:ServiceCatalogTermsContext={repository:rules,scope:{...authority.scope,ownerId:undefined},stored:authority.stored,now:authority.now,scopes},
  terms=await serviceCatalogTermsSources(actor,tx,context,[entry]),currency=await nativeServiceCatalogCurrency(tx,actor.organizationId,root.currency);
 if(!currency||currency.minorUnit<0||currency.minorUnit>2)throw new ServiceOrderConfigurationError();
 const checks=[...authority.checks,...financialChecks,...terms.checks],total=root.totalAmount?Money.of(root.totalAmount.toFixed(2),root.currency):null,
  sourceFingerprint=commandFingerprint({authority:authority.fingerprint,catalog,terms:terms.fingerprint,scopes,currency});
 async function recheck(extra:readonly CurrentAuthorityCheck[]=[]){
  const current=await serviceOrderAuthority(actor,tx,head);await recheckAccountAuthorization(actor,tx,current.now,[...checks,...extra],new ServiceOrderAccessError());
  const original=await rules.sourceMetadataWitness(catalog.id),currentScopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:root!.propertyId,source:current.reservation.source,asOf:current.now}),
   latest=await serviceCatalogTermsSources(actor,tx,{...context,stored:current.stored,now:current.now,scopes:currentScopes},[entry]),currentCurrency=await nativeServiceCatalogCurrency(tx,actor.organizationId,root!.currency);
  if(commandFingerprint({authority:current.fingerprint,catalog:original,terms:latest.fingerprint,scopes:currentScopes,currency:currentCurrency})!==sourceFingerprint)throw new ServiceOrderConflictError();
 }
 function actionCheck(action:Action,amount=total?.toJSON().amount):CurrentAuthorityCheck{return{action,resource:{...authority.resource,dataClass:"financial",amount,occurredAt:head.createdAt}};}
 return{root,head,request,entry,authority,context,terms,currency,total,checks,sourceFingerprint,recheck,actionCheck};
}
