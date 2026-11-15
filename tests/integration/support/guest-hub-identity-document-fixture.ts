import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {guestHubIdentityDocumentPolicyKey,type GuestHubIdentityDocumentPolicy} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import {nativeGuestHubStayDetailsFixture} from "./guest-hub-stay-details-fixture";
import {ownedGuestHubIdentityDocumentPolicy} from "./guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentDelegation} from "./guest-hub-identity-document-delegation";

export async function nativeGuestHubIdentityDocumentFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<GuestHubIdentityDocumentPolicy>={},existing?:Parameters<typeof nativeGuestHubStayDetailsFixture>[3]){
 const f=await nativeGuestHubStayDetailsFixture(admin,db,{},existing),identityPolicy=ownedGuestHubIdentityDocumentPolicy(changes),canonical=ownedGuestHubIdentityDocumentDelegation();
 await withTenant(db,f.organizationId,async tx=>{
  for(const key of["guest_hub_identity_documents:view","guest_hub_identity_documents:create","guest_hub_identity_documents:void","property:view","document:view","document:create","document:edit"]){
   const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_identity_"+randomUUID(),name:"Independent private identity "+key}});
   await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});f.grants[key]=assignment.id;
  }
  const rules=new ConfigRuleRepository(tx,f.organizationId);
  for(const[key,scopeType,value]of [[guestHubIdentityDocumentPolicyKey,"property",identityPolicy],["documents.archive","property",canonical.archivePolicy.value],["documents.retention","organization",canonical.retentionPolicy.value]]as const)await rules.createVersion({key,scopeType,scopeId:scopeType==="organization"?null:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value,reason:"Explicit owned identity capture and canonical archive approval"});
 });
 return{...f,identityPolicy,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}}};
}
