import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {managementAgreementInputSchema,managementAgreementRuleKeys} from "@/modules/core/domain/owner-property";
import {financialRuleSourceChecks} from "@/platform/config/financial-rule-authority";
import {createManagementAgreement} from "@/modules/core/application/core-service";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {reviewOnboardingOperatingStep,admitOnboardingOperatingStep} from "@/modules/onboarding/application/onboarding-service";
import {canonicalOnboardingManagementAgreementDraft} from "@/modules/onboarding/domain/onboarding-management-agreement";
import {nativeOnboardingAdmission} from "./onboarding-fixture";
import {nativeOnboardingPropertyFixture,nativeOnboardingPropertyAdmission} from "./onboarding-property-fixture";

import {nativeOnboardingManagementAgreementTerms} from "./onboarding-management-agreement-terms";
export {nativeOnboardingManagementAgreementTerms};

export async function nativeOnboardingManagementAgreementFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv){
 const f=await nativeOnboardingPropertyFixture(admin,db,env),policy=onboardingPolicySchema.parse({...f.policy,operating_profile_modes:["LINK"],management_agreement_modes:["CREATE","LINK"]}),originalHeld={...f.ctx,authContext:f.ctx.authContext};
 const required=new Set(["config_rule:view","config_rule:export","config_rule:create","config_rule:configure",...managementAgreementRuleKeys.flatMap(key=>financialRuleSourceChecks(f.organizationId,key,"export")).map(check=>check.resource.type+":"+check.action)]);
 await withTenant(db,f.organizationId,async tx=>{await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Actual explicitly enabled native agreement review fixture"});for(const key of required){const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_agreement_"+randomUUID(),name:"Independent financial "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});f.grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,roleId:role.id,userAccountId:f.account.id,personId:f.person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}});
 f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};const owner=await nativeOnboardingAdmission(f,db),property=await nativeOnboardingPropertyAdmission(f,db,owner.receipt),operatingDraft={sessionId:owner.receipt.sessionId,previousRevisionId:property.receipt.id,step:"OPERATING_PROFILE",target:{mode:"LINK",propertyId:property.receipt.propertyId}},operatingReview=await reviewOnboardingOperatingStep(f.ctx,operatingDraft,{db,env}),operating=await admitOnboardingOperatingStep(f.ctx,{...operatingDraft,idempotencyKey:randomUUID(),reviewFingerprint:operatingReview.reviewFingerprint,reason:"Actual confirmed operating predecessor for financial terms"},{db,env});
 const terms=nativeOnboardingManagementAgreementTerms(),agreement=await createManagementAgreement(f.ctx,managementAgreementInputSchema.parse({...terms,effectiveTo:undefined,propertyId:property.receipt.propertyId,status:"DRAFT",reason:"Actual canonical native source agreement fixture"}),{db,requestId:randomUUID()}),draft=canonicalOnboardingManagementAgreementDraft({sessionId:owner.receipt.sessionId,previousRevisionId:operating.id,step:"MANAGEMENT_AGREEMENT",target:{mode:"LINK",propertyId:property.receipt.propertyId,agreementId:agreement.id}});
 return{...f,policy,originalHeld,owner,property,operating,terms,agreement,draft,deps:{db,env}};
}
