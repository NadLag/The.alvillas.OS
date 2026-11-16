import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {previewServiceCatalogChange,publishServiceCatalogChange} from "@/modules/services/application/service-catalog-service";
import {nativeServiceOrderFixture} from "./service-order-fixture";
import type {NativeGuestHubFixtureIdentity} from "./guest-hub-fixture";
import {ownedChefMenu} from "../../support/chef-menu-definition";
export {ownedChefMenu} from "../../support/chef-menu-definition";


export async function nativeChefMenuFixture(admin:PrismaClient,db:PrismaClient,identity?:NativeGuestHubFixtureIdentity){
 const f=await nativeServiceOrderFixture(admin,db,identity),people=await withTenant(db,f.organizationId,async tx=>{
  const chef=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Actual assigned native chef"}}),chefAccount=await tx.userAccount.create({data:{organizationId:f.organizationId,personId:chef.id}}),role=await tx.role.findFirstOrThrow({where:{organizationId:f.organizationId,key:"chef"}}),chefAssignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:chef.id,userAccountId:chefAccount.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,conditions:{assignedToMe:true},validFrom:new Date("2020-01-01")}});
  const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"team_member:view"}}),authorRole=await tx.role.create({data:{organizationId:f.organizationId,key:"chef_author_"+randomUUID(),name:"Explicit independent chef person access"}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:authorRole.id,permissionId:permission.id}});const authorGrant=await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:authorRole.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});
  const allocation=await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"finance.service_allocation",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),createdBy:f.account.id,reason:"Explicit fictional approved chef person ownership recipe",value:{...serviceAllocationPolicySchema.parse(f.policies.allocation.value),services:serviceAllocationPolicySchema.parse(f.policies.allocation.value).services.map(recipe=>({...recipe,components:recipe.components.map(component=>component.key==="provider"?{...component,beneficiary:"PERSON"}:component)}))}});
  return{chef,chefAccount,chefAssignment,authorGrant,allocation};
 });
 const ctx={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},chefContext={organizationId:f.organizationId,actorId:people.chefAccount.id,personId:people.chef.id,authContext:{...await authContextForAccount(f.organizationId,people.chefAccount.id,{db}),personId:people.chef.id}},draft={...f.draft,entry:{...f.entry,name:{en:"Owned chef dinner",fr:"Dîner du chef contrôlé",ar:"عشاء الشيف للاختبار"},description:{en:"Actual configurable chef menu",fr:"Menu réel et configurable",ar:"قائمة شيف قابلة للإعداد"},order_terms:{...f.entry.order_terms,providers:[{component_key:"provider",kind:"PERSON" as const,id:people.chef.id}],allocation_rule_id:people.allocation.id,chef_menu:ownedChefMenu}}},review=await previewServiceCatalogChange(ctx,draft,f.deps),published=await publishServiceCatalogChange(ctx,{draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);
 return{...f,...people,ctx,chefContext,draft,entry:draft.entry,published};
}
