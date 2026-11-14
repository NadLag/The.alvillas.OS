import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {guestHubProfilePolicyKey,type GuestHubProfilePolicy} from "@/modules/guest-hub/domain/guest-hub-profile-policy";
import {nativeGuestHubFixture,type NativeGuestHubFixtureIdentity} from "./guest-hub-fixture";

export function ownedGuestHubProfilePolicy():GuestHubProfilePolicy{return{source:"NATIVE_RESERVATION_GUEST_PROFILE",history:"APPEND_ONLY_RESERVATION_PROFILE",enabled:true,processing_approval_reference:"Explicit owned-test profile processing decision",notice:{reference:"Owned-test notice reference, not a legal default",title:{en:"Owned profile notice",fr:"Notice du profil de test",ar:"إشعار الملف للاختبار"},paragraphs:[{en:"Owned-test profile collection for this reservation.",fr:"Collecte de profil de test pour cette réservation.",ar:"جمع بيانات الملف لهذه الحجز للاختبار."}]},require_acknowledgement:true,allowed_fields:["displayName","email","phone","preferredLocale"],required_fields:["displayName","email"],submissions:{requests:100,window_seconds:3600}};}
export async function nativeGuestHubProfileFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<GuestHubProfilePolicy>={},identity?:NativeGuestHubFixtureIdentity){
 const f=await nativeGuestHubFixture(admin,db,{},identity),profilePolicy={...ownedGuestHubProfilePolicy(),...changes};
 await withTenant(db,f.organizationId,async tx=>{
  for(const key of["guest:edit","guest_hub_profile:view","guest_hub_profile:create","guest_hub_profile:void"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_profile_"+randomUUID(),name:"Independent native profile "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});f.grants[key]=assignment.id;}
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:guestHubProfilePolicyKey,scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:profilePolicy,reason:"Explicit owned-test profile processing and field approval"});
 });
 return{...f,profilePolicy,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}}};
}
