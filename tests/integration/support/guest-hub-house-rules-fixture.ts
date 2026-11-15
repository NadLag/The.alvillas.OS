import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {guestHubHouseRulesPolicyKey,type GuestHubHouseRulesPolicy} from "@/modules/guest-hub/domain/guest-hub-house-rules-policy";
import {nativeGuestHubFixture,type NativeGuestHubFixtureIdentity} from "./guest-hub-fixture";
import {ownedGuestHubHouseRulesPolicy} from "./guest-hub-house-rules-policy";

export async function nativeGuestHubHouseRulesFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<GuestHubHouseRulesPolicy>={},identity?:NativeGuestHubFixtureIdentity){
 const f=await nativeGuestHubFixture(admin,db,{},identity),houseRulesPolicy=ownedGuestHubHouseRulesPolicy(changes);
 await withTenant(db,f.organizationId,async tx=>{
  for(const key of["guest:edit","guest_hub_house_rules:view","guest_hub_house_rules:create","guest_hub_house_rules:void"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_house_rules_"+randomUUID(),name:"Independent native house rules "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});f.grants[key]=assignment.id;}
  await tx.propertyOnboardingProfile.create({data:{organizationId:f.organizationId,propertyId:f.property.id,createdBy:f.account.id,houseRules:houseRulesPolicy.approved_content?.source_rules??[]}});
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:guestHubHouseRulesPolicyKey,scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:houseRulesPolicy,reason:"Explicit owned canonical house rules wording and processing approval"});
 });
 return{...f,houseRulesPolicy,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}}};
}
