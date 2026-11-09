import type {TenantTransaction} from "@/platform/db/tenant";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
export {managementAgreementRuleKeys as onboardingManagementAgreementRuleKeys} from "@/modules/core/domain/owner-property";

/** Native heads contain identity/version/tuple witnesses, never private references or financial values. */
export function nativeOnboardingManagementAgreementHeads(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingManagementAgreementHeads(ids,includeArchived);}
export function nativeOnboardingManagementAgreementRuleHeads(tx:TenantTransaction,organizationId:string,agreementId:string){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleHeads(agreementId);}
export function nativeOnboardingManagementAgreementChoices(tx:TenantTransaction,organizationId:string,propertyId:string,query:string,after:string|undefined,asOf:Date){return new CoreRepository(tx,organizationId).onboardingManagementAgreementPage(propertyId,query,after,asOf);}

/** The application checks independent held/current financial source authority before these private reads. */
export function nativeOnboardingManagementAgreementRows(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRows(ids,includeArchived);}
export function nativeOnboardingManagementAgreementRuleRows(tx:TenantTransaction,organizationId:string,ids:readonly string[]){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleRows(ids);}

/** Authorization uses dated native heads; persisted witnesses retain pins only. */
export function nativeOnboardingManagementAgreementSourcePins(head:Awaited<ReturnType<typeof nativeOnboardingManagementAgreementHeads>>[number]|null,rules:Awaited<ReturnType<typeof nativeOnboardingManagementAgreementRuleHeads>>){
 return{agreement:head?{id:head.id,propertyId:head.propertyId,xmin:head.xmin,tuple:head.tuple}:null,rules:rules.map(rule=>({id:rule.id,key:rule.key,version:rule.version,scopeType:rule.scopeType,scopeId:rule.scopeId,xmin:rule.xmin,tuple:rule.tuple}))};
}
