import type {NativeOnboardingFixtureIdentity} from "./onboarding-fixture";
import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {configuredNativeOnboardingPropertyProfile,createNativeOnboardingProperty} from "@/platform/onboarding/property-source";
import {nativeOnboardingFixture,type NativeOnboardingFixture} from "./onboarding-fixture";
import {reviewOnboardingPropertyStep,admitOnboardingPropertyStep} from "@/modules/onboarding/application/onboarding-service";
import {canonicalOnboardingPropertyDraft,canonicalOnboardingPropertyCommand,type OnboardingPropertyDraft} from "@/modules/onboarding/domain/onboarding-property";
import {createProperty} from "@/modules/core/application/core-service";
import {propertyInputSchema} from "@/modules/core/domain/owner-property";

export const nativeOnboardingPropertyRule={key:"ops.operating_rules"as const,entry:"initial_property_profile"};
export function nativeOnboardingPropertyProfile(){return{cleaningEnabled:false,cleaningFrequency:"NONE",inspectionEnabled:true,inspectionFrequency:"CHECKOUT",poolServiceEnabled:true,poolServiceFrequency:"ON_DEMAND",gardenServiceEnabled:false,gardenServiceFrequency:"NONE",laundryManaged:false,linenManaged:false,maintenanceTrackingEnabled:true,preventiveMaintenanceFrequency:"MONTHLY",midStayCleaningEnabled:false,breakfastAvailable:false,chefAvailable:true,transfersAvailable:false,groceriesAvailable:true,wellnessAvailable:false,otherServices:["Actual configured optional service"]};}
export async function nativeOnboardingPropertyFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,identity?:NativeOnboardingFixtureIdentity){
 const f=await nativeOnboardingFixture(admin,db,env,{property_modes:["CREATE","LINK"],property_creation_rule:nativeOnboardingPropertyRule},identity);
 await withTenant(db,f.organizationId,async tx=>{for(const key of["property:view","property:create","property:edit"]){const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_property_step_"+randomUUID(),name:"Independent "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});f.grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,roleId:role.id,userAccountId:f.account.id,personId:f.person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:nativeOnboardingPropertyRule.key,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{rules:{[nativeOnboardingPropertyRule.entry]:nativeOnboardingPropertyProfile()}},reason:"Actual explicitly configured native onboarding Property choices"});});
 f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};return f;
}
export async function existingNativeOnboardingProperty(f:NativeOnboardingFixture,db:PrismaClient,ownerId:string,name="Actual selected Property "+randomUUID()){
 return withTenant(db,f.organizationId,async tx=>{const configured=await configuredNativeOnboardingPropertyProfile(tx,f.organizationId,nativeOnboardingPropertyRule,new Date());return createNativeOnboardingProperty(f.ctx,tx,{ownerId,name,addressLine1:"Actual private Property address",city:"Marrakech",propertyType:"VILLA",bedrooms:3,bathrooms:2,maxGuests:6,status:"DRAFT"},randomUUID(),configured.profile);});
}
export async function nativeOnboardingPropertyAdmission(f:NativeOnboardingFixture,db:PrismaClient,previous:{id:string;sessionId:string;ownerId:string},target?:OnboardingPropertyDraft["target"]){
 if(!target&&f.canonicalPropertyInput){const configured=await withTenant(db,f.organizationId,tx=>configuredNativeOnboardingPropertyProfile(tx,f.organizationId,nativeOnboardingPropertyRule,new Date())),property=await createProperty(f.ctx,propertyInputSchema.parse({...f.canonicalPropertyInput,ownerId:previous.ownerId,operatingProfile:configured.profile,status:"DRAFT"}),{db,requestId:randomUUID()});target={mode:"LINK",propertyId:property.id};}
 const draft=canonicalOnboardingPropertyDraft({sessionId:previous.sessionId,previousRevisionId:previous.id,step:"PROPERTY",target:target??{mode:"CREATE",input:{ownerId:previous.ownerId,name:"Original native historical Property",addressLine1:"Original native historical address",city:"Marrakech",propertyType:"VILLA",bedrooms:3,bathrooms:2,maxGuests:6,status:"DRAFT"}}}),review=await reviewOnboardingPropertyStep(f.ctx,draft,{db,env:f.env}),command=canonicalOnboardingPropertyCommand({...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed original Property history"}),receipt=await admitOnboardingPropertyStep(f.ctx,command,{db,env:f.env});return{draft,review,command,receipt};
}
