import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {configurationPropertyHead,configurationSourceClock} from "@/platform/config/property-source";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {financialRuleSourceChecks} from "@/platform/config/financial-rule-authority";
import {serviceCatalogRuleKey,servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {serviceAllocationPolicyKey,serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {taxRuleSchema} from "@/platform/config/rule-registry";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeServiceCatalogProviders} from "@/platform/services/catalog-provider-source";
import {ServiceCatalogAccessError,ServiceCatalogConfigurationError,ServiceCatalogConflictError,type ServiceCatalogEntry} from "../domain/service-catalog";

export type ServiceCatalogScope={propertyId:string;ownerId?:string;source?:string};
export async function serviceCatalogSourceContext(actor:AccountActorContext,tx:TenantTransaction,input:ServiceCatalogScope,action:"view"|"configure"="view"){
 const[property,stored,now]=await Promise.all([configurationPropertyHead(tx,actor.organizationId,input.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),configurationSourceClock(tx,actor.organizationId)]);
 if(!property||input.ownerId&&!property.ownership.some(row=>row.ownerId===input.ownerId))throw new ServiceCatalogAccessError();
 const scope={organizationId:actor.organizationId,propertyId:property.id,ownerId:input.ownerId,city:property.cityId,region:property.regionId},target={...scope,type:"service",id:serviceCatalogRuleKey},checks:CurrentAuthorityCheck[]=[{action:"view",resource:{...scope,type:"property",id:property.id,status:property.status,occurredAt:property.createdAt}},{action:"view",resource:target},...action==="configure"?[{action,resource:target}]:[],...(["view","export"]as const).flatMap(verb=>[{action:verb,unconditional:true,resource:{...scope,type:"config_rule",id:serviceCatalogRuleKey,dataClass:"financial"as const}},{action:verb,unconditional:true,resource:{...scope,type:"financial_transaction",dataClass:"financial"as const}}])];
 if(action==="configure")checks.push({action:"configure",resource:{...scope,type:"config_rule",id:serviceCatalogRuleKey,dataClass:"financial"}});
 assertAccountAuthorization(actor,stored,now,checks,new ServiceCatalogAccessError());const repository=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:property.id,ownerId:input.ownerId,source:input.source,asOf:now}),rule=await repository.resolveMetadata({key:serviceCatalogRuleKey,scopes,asOf:now}),witness=rule?await repository.sourceMetadataWitness(rule.id):null;
 if(rule&&(!witness||witness.archivedAt||!["ACTIVE","RETIRED"].includes(witness.lifecycle)||!witness.createdBy||witness.version!==rule.version))throw new ServiceCatalogConfigurationError();
 if(witness){const sourceChecks:CurrentAuthorityCheck[]=(["view","export"]as const).map(verb=>({action:verb,unconditional:true,resource:{...scope,type:"config_rule",id:witness.id,dataClass:"financial",status:witness.lifecycle,occurredAt:witness.createdAt}}));assertAccountAuthorization(actor,stored,now,sourceChecks,new ServiceCatalogAccessError());checks.push(...sourceChecks);}
 return{property,stored,now,scope,target,checks,repository,scopes,rule,witness,authorizationFingerprint:commandFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)}),fingerprint:commandFingerprint({property,rule:witness,scopes})};
}

export async function readNativeServiceCatalog(actor:AccountActorContext,tx:TenantTransaction,input:ServiceCatalogScope,action:"view"|"configure"="view"){
 const context=await serviceCatalogSourceContext(actor,tx,input,action),row=context.rule?await context.repository.sourceWitness(context.rule.id):null;
 if(row&&(!context.witness||row.xmin!==context.witness.xmin||row.tuple!==context.witness.tuple||row.key!==serviceCatalogRuleKey))throw new ServiceCatalogConflictError();
 const catalog=row?servicePricingSchema.parse(row.value):null;return{...context,catalog};
}

/** Metadata and private policy values are fetched in batches for the selected
 * page/edited item. All independent financial and person sources stay explicit. */
export type ServiceCatalogTermsContext=Pick<Awaited<ReturnType<typeof serviceCatalogSourceContext>>,"repository"|"scope"|"stored"|"now"|"scopes">;
export async function serviceCatalogFinancialSources(actor:AccountActorContext,context:ServiceCatalogTermsContext,requestedIds:readonly string[]){
 const ids=[...new Set(requestedIds)],heads=await context.repository.sourceMetadataWitnesses(ids);
 if(heads.length!==ids.length||heads.some(row=>row.archivedAt||!row.createdBy||![serviceAllocationPolicyKey,"finance.tax"].includes(row.key)))throw new ServiceCatalogAccessError();
 const checks:CurrentAuthorityCheck[]=[...new Set(heads.map(row=>row.key))].flatMap(key=>financialRuleSourceChecks(actor.organizationId,key,"export"));for(const row of heads)for(const verb of["view","export"]as const)checks.push({action:verb,organizationOnly:true,resource:{type:"config_rule",organizationId:actor.organizationId,id:row.id,dataClass:"financial",status:row.lifecycle,occurredAt:row.createdAt}});
 assertAccountAuthorization(actor,context.stored,context.now,checks,new ServiceCatalogAccessError());const rows=await context.repository.sourceWitnesses(ids);if(rows.length!==heads.length||rows.some(row=>{const head=heads.find(candidate=>candidate.id===row.id);return!head||head.xmin!==row.xmin||head.tuple!==row.tuple;}))throw new ServiceCatalogConflictError();
 return{heads,rows,checks};
}
export async function serviceCatalogTermsSources(actor:AccountActorContext,tx:TenantTransaction,context:ServiceCatalogTermsContext,items:readonly ServiceCatalogEntry[],requireCurrent=false){
 const terms=items.flatMap(item=>item.order_terms?[{item,terms:item.order_terms}]:[]),{heads,rows,checks}=await serviceCatalogFinancialSources(actor,context,terms.flatMap(row=>[row.terms.allocation_rule_id,row.terms.tax_rule_id]));
 const current=requireCurrent?await Promise.all([context.repository.resolveMetadata({key:serviceAllocationPolicyKey,scopes:context.scopes,asOf:context.now}),context.repository.resolveMetadata({key:"finance.tax",scopes:context.scopes,asOf:context.now})]):null,providers=await nativeServiceCatalogProviders(actor,tx,terms.flatMap(row=>row.terms.providers),context.stored,context.now,{allowArchived:!requireCurrent}),policies=[];
 for(const entry of terms){const allocation=rows.find(row=>row.id===entry.terms.allocation_rule_id),tax=rows.find(row=>row.id===entry.terms.tax_rule_id);if(!allocation||allocation.key!==serviceAllocationPolicyKey||!tax||tax.key!=="finance.tax"||requireCurrent&&(current?.[0]?.id!==allocation.id||current?.[1]?.id!==tax.id))throw new ServiceCatalogConfigurationError();const recipe=serviceAllocationPolicySchema.parse(allocation.value).services.find(row=>row.service_key===entry.item.key),taxes=taxRuleSchema.parse(tax.value);if(!recipe||recipe.currency!==entry.item.currency||entry.terms.internal_cost.currency!==entry.item.currency)throw new ServiceCatalogConfigurationError();
  const providerParts=recipe.components.filter(row=>row.beneficiary==="SUPPLIER"||row.beneficiary==="PERSON");if(providerParts.length!==entry.terms.providers.length||providerParts.some(part=>!entry.terms.providers.some(provider=>provider.component_key===part.key&&provider.kind===part.beneficiary))||recipe.tax_rule_keys.some(key=>{
   const selected=taxes.taxes.filter(row=>row.key===key);if(selected.length!==1)return true;const tax=selected[0];
   return!tax.service_assessment||(tax.service_assessment.method==="FIXED"?(tax.amount===undefined||tax.currency!==entry.item.currency):tax.rate_bps===undefined);
  }))throw new ServiceCatalogConfigurationError();
  policies.push({serviceKey:entry.item.key,allocationRuleId:allocation.id,allocationRuleVersion:allocation.version,taxRuleId:tax.id,taxRuleVersion:tax.version,recipe,taxes:taxes.taxes.filter(row=>recipe.tax_rule_keys.includes(row.key)).map(row=>({key:row.key,amount:row.amount??null,currency:row.currency??null,rate_bps:row.rate_bps??null,service_assessment:row.service_assessment!})),providers:providers.items.filter(row=>entry.terms.providers.some(ref=>ref.component_key===row.component_key&&ref.kind===row.kind&&ref.id===row.id))});
 }
 return{policies,checks:[...checks,...providers.checks],fingerprint:commandFingerprint({heads,providers:providers.fingerprint,current})};
}
