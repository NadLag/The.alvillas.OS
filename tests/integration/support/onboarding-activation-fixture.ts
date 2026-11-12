import type {NativeOnboardingFixtureIdentity} from "./onboarding-fixture";
import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {reviewOnboardingConfiguration,admitOnboardingConfiguration} from "@/modules/onboarding/application/onboarding-service";
import {nativeOnboardingConfigurationFixture} from "./onboarding-configuration-fixture";

/** Ten actual native records precede an independently authorized background intent. */
export async function nativeOnboardingActivationFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,enabled=true,identity?:NativeOnboardingFixtureIdentity){
 const f=await nativeOnboardingConfigurationFixture(admin,db,env,identity),policy=onboardingPolicySchema.parse({...f.policy,...enabled?{activation:{modes:["BACKGROUND"],effects:["WORKFLOWS","DOCUMENTS","EMAIL","TASKS","NOTIFICATION"],retry:{max_attempts:3,backoff_seconds:30}}}:{}});
 await withTenant(db,f.organizationId,async tx=>{
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit reviewed activation effects and configured retry policy"});
  const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"onboarding:approve"}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_activation_"+randomUUID(),name:"Explicit independent property activation approval",rolePermissions:{create:{organizationId:f.organizationId,permissionId:permission.id}}}});
  f.grants["onboarding:approve"]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;
 });
 f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};const reviewed=await reviewOnboardingConfiguration(f.ctx,f.configurationDraft,f.deps),review=await admitOnboardingConfiguration(f.ctx,{...f.configurationDraft,idempotencyKey:randomUUID(),reviewFingerprint:reviewed.reviewFingerprint,reason:"Actual complete native Review before durable activation"},f.deps);
 return{...f,policy,review,activationDraft:{sessionId:review.sessionId,previousRevisionId:review.id,step:"ACTIVATE"as const,target:{mode:"BACKGROUND"as const,propertyId:review.propertyId!}}};
}
