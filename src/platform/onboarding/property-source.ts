import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {onboardingPropertyInputSchema,parseConfiguredOnboardingPropertyProfile} from "./contracts";
import {onboardingPropertySnapshotSchema} from "@/modules/onboarding/domain/onboarding-property";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {z} from "zod";
import {propertyInputSchema} from "@/modules/core/domain/owner-property";

export function nativeOnboardingPropertyHeads(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingPropertyHeads(ids,includeArchived);}
export function lockNativeOnboardingProperty(tx:TenantTransaction,organizationId:string,propertyId:string){return new CoreRepository(tx,organizationId).lockOnboardingProperty(propertyId);}
export function nativeOnboardingPropertyRows(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false){return new CoreRepository(tx,organizationId).onboardingPropertyIdentityRows(ids,includeArchived);}
export function nativeOnboardingPropertyChoices(tx:TenantTransaction,organizationId:string,ownerId:string,query:string,after:string|undefined,asOf:Date){return new CoreRepository(tx,organizationId).onboardingPropertyPage(ownerId,query,after,asOf);}
export function nativeOnboardingPropertyProjection(row:Awaited<ReturnType<CoreRepository["onboardingPropertyIdentityRows"]>>[number]){
 return onboardingPropertySnapshotSchema.parse({id:row.id,name:row.name,addressLine1:row.addressLine1,addressLine2:row.addressLine2,cityId:row.cityId,regionId:row.regionId,city:row.city,region:row.region,countryCode:row.countryCode,propertyType:row.propertyType,bedrooms:row.bedrooms,bathrooms:row.bathrooms,livingSpaces:row.livingSpaces,parkingSpaces:row.parkingSpaces,maxGuests:row.maxGuests,hasPool:row.hasPool,hasGarden:row.hasGarden,timezone:row.timezone,amenities:row.amenities,photoUrls:row.photoUrls,status:row.status});
}
export async function configuredNativeOnboardingPropertyProfile(tx:TenantTransaction,organizationId:string,reference:{key:"ops.operating_rules";entry:string},now:Date){
 const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:reference.key,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
 if(!rule?.createdBy||rule.lifecycle!=="ACTIVE")throw new Error("native_onboarding_property_configuration_required");
 const value=z.object({rules:z.record(z.string(),z.unknown())}).passthrough().parse(rule.parsedValue);
 if(!Object.hasOwn(value.rules,reference.entry))throw new Error("native_onboarding_property_configuration_required");
 return{ruleId:rule.id,version:rule.version,key:reference.key,entry:reference.entry,profile:parseConfiguredOnboardingPropertyProfile(value.rules[reference.entry])};
}
export async function createNativeOnboardingProperty(actor:AccountActorContext,tx:TenantTransaction,raw:unknown,requestId:string,configuredProfile:unknown){
 const input=propertyInputSchema.parse({...onboardingPropertyInputSchema.parse(raw),operatingProfile:parseConfiguredOnboardingPropertyProfile(configuredProfile)}),{createProperty}=await import("@/modules/core/application/core-service");
 return createProperty(actor,input,{db:{$transaction:work=>work(tx)},requestId});
}
