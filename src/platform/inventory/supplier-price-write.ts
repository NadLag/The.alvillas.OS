import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {nativeServiceCatalogActor} from "@/platform/services/catalog-provider-source";
import {createConfigRuleVersion,activateConfigRuleVersion,retireConfigRuleVersion,ConfigAuthorizationError,ConfigNotFoundError,ConfigValidationError} from "@/modules/config/application/config-service";
import {InventoryCatalogAccessError,InventoryCatalogDefinitionError} from "@/modules/inventory/domain/catalog-errors";
import {ServiceCatalogAccessError} from "@/modules/services/domain/service-catalog";
import type {SupplierPriceDraft} from "@/modules/inventory/domain/supplier-price-command";
import {laundrySupplierPricePolicyKey} from "@/platform/config/laundry-pricing-policy";
/** The existing configuration writer owns version numbers, lifecycle, scope,
 * effective dates, canonical values, attributed audit and supplier reference. */
export async function writeNativeSupplierPrice(actor:AccountActorContext,tx:TenantTransaction,draft:SupplierPriceDraft,requestId:string){
 try{const current=await nativeServiceCatalogActor(actor,tx),db={$transaction:async<T>(work:(transaction:TenantTransaction)=>Promise<T>)=>work(tx)},deps={db,requestId,ipAddress:null};
  if(draft.kind==="CREATE")return await createConfigRuleVersion(current,{key:laundrySupplierPricePolicyKey(draft.supplierId),scopeType:draft.scope.scopeType,...draft.scope.scopeId?{scopeId:draft.scope.scopeId}:{},valueJson:JSON.stringify(draft.policy),lifecycle:draft.lifecycle,effectiveFrom:new Date(draft.effectiveFrom),...draft.effectiveTo?{effectiveTo:new Date(draft.effectiveTo)}:{},reason:draft.reason},deps);
  const input={ruleId:draft.versionId,effectiveFrom:new Date(draft.effectiveFrom),reason:draft.reason};return await(draft.kind==="ACTIVATE"?activateConfigRuleVersion(current,input,deps):retireConfigRuleVersion(current,input,deps));
 }catch(error){if(error instanceof ConfigAuthorizationError||error instanceof ConfigNotFoundError||error instanceof ServiceCatalogAccessError)throw new InventoryCatalogAccessError();if(error instanceof ConfigValidationError)throw new InventoryCatalogDefinitionError();throw error;}
}
