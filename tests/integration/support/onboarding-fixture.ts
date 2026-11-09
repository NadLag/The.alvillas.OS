import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {createNativeOnboardingOwner} from "@/platform/onboarding/owner-source";
import {onboardingPolicyKey,type OnboardingPolicy} from "@/modules/onboarding/domain/onboarding-policy";
import {reviewOnboardingStep,admitOnboardingStep} from "@/modules/onboarding/application/onboarding-service";
import type {OnboardingDraft} from "@/modules/onboarding/domain/onboarding-wizard";

export const onboardingFixturePermissions=["onboarding:view","onboarding:create","onboarding:edit","onboarding:export","owner:view","owner:create","owner:edit"]as const;
export function nativeOnboardingPolicy(changes:Partial<OnboardingPolicy>={}):OnboardingPolicy{return{source:"NATIVE_REVIEWED_PROPERTY_ONBOARDING",history:"APPEND_ONLY_NATIVE_ONBOARDING_STEPS",progress:"DERIVED_FROM_NATIVE_RECORDS",encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",release:"NATIVE_DELIVERY_READINESS",owner_modes:["CREATE","LINK"],admission:{requests:1000,window_seconds:3600},reads:{requests:2000,window_seconds:3600},...changes};}
export function nativeOnboardingOwnerInput(){return{displayName:"Actual native onboarding owner "+randomUUID(),legalName:"Actual recorded legal name",email:randomUUID()+"@native-onboarding.test",phone:"+212600000000",preferredLocale:"fr"as const,notes:"Private original canonical owner notes"};}
export async function nativeOnboardingFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,changes:Partial<OnboardingPolicy>={}){
 const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Actual native wizard acceptance"}});await ensureStandardIdentitySetup(organizationId,{db:admin});
 const saved=await withTenant(db,organizationId,async tx=>{const person=await tx.person.create({data:{organizationId,displayName:"Actual independently scoped wizard operator"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}}),grants:Record<string,string>={};for(const key of onboardingFixturePermissions){const role=await tx.role.create({data:{organizationId,key:"native_wizard_"+key.replace(":","_")+"_"+randomUUID(),name:"Explicit independent "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId,key}});await tx.rolePermission.create({data:{organizationId,roleId:role.id,permissionId:permission.id}});grants[key]=(await tx.roleAssignment.create({data:{organizationId,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}const policy=nativeOnboardingPolicy(changes),rule=await new ConfigRuleRepository(tx,organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit approved native wizard admission/read policy"});return{person,account,grants,policy,rule};});
 const ctx={organizationId,actorId:saved.account.id,authContext:{...await authContextForAccount(organizationId,saved.account.id,{db}),personId:saved.person.id}};return{organizationId,...saved,ctx,env};
}
export type NativeOnboardingFixture=Awaited<ReturnType<typeof nativeOnboardingFixture>>;
export async function existingNativeOnboardingOwner(f:NativeOnboardingFixture,db:PrismaClient,input=nativeOnboardingOwnerInput()){return withTenant(db,f.organizationId,tx=>createNativeOnboardingOwner(f.ctx,tx,input,randomUUID()));}
export function nativeOnboardingDraft(input=nativeOnboardingOwnerInput()):OnboardingDraft{return{sessionId:null,previousRevisionId:null,step:"OWNER",target:{mode:"CREATE",input}};}
export async function nativeOnboardingAdmission(f:NativeOnboardingFixture,db:PrismaClient,draft:OnboardingDraft=nativeOnboardingDraft()){
 const deps={db,env:f.env},review=await reviewOnboardingStep(f.ctx,draft,deps),command={...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed native owner step"},receipt=await admitOnboardingStep(f.ctx,command,deps);return{draft,review,command,receipt};
}
