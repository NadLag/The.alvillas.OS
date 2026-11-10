import type {TenantTransaction} from "@/platform/db/tenant";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {managementAgreementInputSchema} from "@/modules/core/domain/owner-property";
import {onboardingManagementAgreementInputSchema} from "./contracts";
export {managementAgreementRuleKeys as onboardingManagementAgreementRuleKeys} from "@/modules/core/domain/owner-property";

/** Native heads contain identity/version/tuple witnesses, never private references or financial values. */
export function nativeOnboardingManagementAgreementHeads(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingManagementAgreementHeads(ids,includeArchived);}
export function nativeOnboardingManagementAgreementRuleHeads(tx:TenantTransaction,organizationId:string,agreementId:string){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleHeads(agreementId);}
export function nativeOnboardingManagementAgreementRuleHeadsMany(tx:TenantTransaction,organizationId:string,agreementIds:readonly string[]){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleHeadsMany(agreementIds);}
export function nativeOnboardingManagementAgreementChoices(tx:TenantTransaction,organizationId:string,propertyId:string,query:string,after:string|undefined,asOf:Date){return new CoreRepository(tx,organizationId).onboardingManagementAgreementPage(propertyId,query,after,asOf);}

/** The application checks independent held/current financial source authority before these private reads. */
export function nativeOnboardingManagementAgreementRows(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRows(ids,includeArchived);}
export function nativeOnboardingManagementAgreementRuleRows(tx:TenantTransaction,organizationId:string,ids:readonly string[]){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleRows(ids);}
export function nativeOnboardingManagementAgreementRuleWitnesses(tx:TenantTransaction,organizationId:string,ids:readonly string[]){return new CoreRepository(tx,organizationId).onboardingManagementAgreementRuleWitnesses(ids);}
export function lockNativeOnboardingManagementAgreement(tx:TenantTransaction,organizationId:string,id:string){return new CoreRepository(tx,organizationId).lockOnboardingManagementAgreement(id);}

/** Core remains the sole writer; native review cannot activate an Agreement or invent financial defaults. */
export async function createNativeOnboardingManagementAgreement(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown,reason:string,requestId:string){
 const explicit=onboardingManagementAgreementInputSchema.parse(raw),input=managementAgreementInputSchema.parse({...explicit,propertyId,status:"DRAFT",effectiveTo:explicit.effectiveTo??undefined,approvalThresholdKey:explicit.approvalThresholdKey??undefined,approvalThresholdAmount:explicit.approvalThresholdAmount??undefined,reason}),{createManagementAgreement}=await import("@/modules/core/application/core-service");
 return createManagementAgreement(actor,input,{db:{$transaction:work=>work(tx)},requestId});
}

/** Authorization uses dated native heads; persisted witnesses retain pins only. */
export function nativeOnboardingManagementAgreementSourcePins(head:Awaited<ReturnType<typeof nativeOnboardingManagementAgreementHeads>>[number]|null,rules:Awaited<ReturnType<typeof nativeOnboardingManagementAgreementRuleHeads>>){
 return{agreement:head?{id:head.id,propertyId:head.propertyId,xmin:head.xmin,tuple:head.tuple}:null,rules:rules.map(rule=>({id:rule.id,key:rule.key,version:rule.version,scopeType:rule.scopeType,scopeId:rule.scopeId,xmin:rule.xmin,tuple:rule.tuple}))};
}
