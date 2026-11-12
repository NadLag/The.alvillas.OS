import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {permissionCatalog} from "@/platform/authz/catalog";
import {reviewOnboardingConfiguration,admitOnboardingConfiguration,readOnboardingConfigurationSession} from "@/modules/onboarding/application/onboarding-service";
import type {nativeOnboardingOwnerPackageFixture} from "./onboarding-owner-package-fixture";

/** Execution grants change actual Team facts; admit a real complete Review after preparing them. */
export async function nativeOnboardingExecutionAuthority(result:Awaited<ReturnType<typeof nativeOnboardingOwnerPackageFixture>>,db:PrismaClient){
 await withTenant(db,result.organizationId,async tx=>{for(const entry of permissionCatalog.filter(row=>["reservation","task","guest"].includes(row.resource)||row.resource==="config_rule"&&["view","export","configure"].includes(row.action))){const permission=await tx.permission.findFirstOrThrow({where:{key:entry.key}}),role=await tx.role.create({data:{organizationId:result.organizationId,key:"workflow_execution_"+randomUUID(),name:"Explicit native workflow permission "+entry.key,rolePermissions:{create:{organizationId:result.organizationId,permissionId:permission.id}}}}),organizationScope=["guest","config_rule"].includes(entry.resource);await tx.roleAssignment.create({data:{organizationId:result.organizationId,personId:result.person.id,userAccountId:result.account.id,roleId:role.id,scopeType:organizationScope?"organization":"property",scopeId:organizationScope?null:result.review.propertyId!,validFrom:new Date("2020-01-01")}});}});
 result.ctx.authContext={...await authContextForAccount(result.organizationId,result.account.id,{db}),personId:result.person.id};
 const draft={sessionId:result.review.sessionId,previousRevisionId:result.review.id,step:"REVIEW"as const,target:{mode:"VALIDATE"as const,propertyId:result.review.propertyId!}},checked=await reviewOnboardingConfiguration(result.ctx,draft,result.deps),review=await admitOnboardingConfiguration(result.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:checked.reviewFingerprint,reason:"Validate actual Team and configuration authority after explicit workflow-execution grants"},result.deps),original=await readOnboardingConfigurationSession(result.ctx,{sessionId:review.sessionId,revisionId:review.id},result.deps);
 return{...result,review,original,activationDraft:{...result.activationDraft,previousRevisionId:review.id},sourceInput:{sessionId:review.sessionId,revisionId:review.id}};
}
