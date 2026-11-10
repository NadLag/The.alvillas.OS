import {randomUUID} from "node:crypto";
import type {PrismaClient,Prisma} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";

/** Actual canonical identity sources; no credentials, finance, or native producer is synthesized. */
export async function nativeOnboardingTeamSourceFixture(admin:PrismaClient,db:PrismaClient){
 const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Actual native Team source acceptance"}});await ensureStandardIdentitySetup(organizationId,{db:admin});
 const rows=await withTenant(db,organizationId,async tx=>{
  const person=await tx.person.create({data:{organizationId,displayName:"Actual Team delegator"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}}),staff=await tx.person.create({data:{organizationId,displayName:"Original private Team person",email:"private-person@example.test",phone:"+212600000000"}}),staffAccount=await tx.userAccount.create({data:{organizationId,personId:staff.id,email:"private-account@example.test"}}),region=await tx.region.create({data:{organizationId,name:"Actual native Team region"}}),city=await tx.city.create({data:{organizationId,name:"Actual native Team city",regionId:region.id}}),property=await tx.property.create({data:{organizationId,name:"Actual Team source Property",addressLine1:"Private source address",city:city.name,cityId:city.id,regionId:region.id,propertyType:"VILLA",bedrooms:2,bathrooms:2,maxGuests:4,amenities:[],photoUrls:[]}}),role=await tx.role.create({data:{organizationId,key:"native_team_source_"+randomUUID(),name:"Original private Team role"}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId,key:"task:view"}});
  await tx.rolePermission.create({data:{organizationId,roleId:role.id,permissionId:permission.id}});
  const grants:Record<string,string>={};for(const key of["role:assign","task:view","team_member:view","identity:view","role:view"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId,key}}),grantRole=await tx.role.create({data:{organizationId,key:"team_source_grant_"+randomUUID(),name:"Independent actual "+key,rolePermissions:{create:{organizationId,permissionId:permission.id}}}});grants[key]=(await tx.roleAssignment.create({data:{organizationId,personId:person.id,userAccountId:account.id,roleId:grantRole.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}
  return{person,account,staff,staffAccount,region,city,property,role,grants};
 });
 return{organizationId,...rows,ctx:{organizationId,actorId:rows.account.id,personId:rows.person.id,authContext:{...await authContextForAccount(organizationId,rows.account.id,{db}),personId:rows.person.id}},input:{personId:rows.staff.id,roleId:rows.role.id,userAccountId:rows.staffAccount.id,scopeType:"property"as const,scopeId:rows.property.id,assignedToMe:false,validFrom:new Date("2020-01-01"),validTo:null,reason:"Explicit actual native Team delegation"}};
}
export type NativeOnboardingTeamSourceFixture=Awaited<ReturnType<typeof nativeOnboardingTeamSourceFixture>>;
export async function nativeOnboardingTeamReadableSourceFixture(admin:PrismaClient,db:PrismaClient){
 const f=await nativeOnboardingTeamSourceFixture(admin,db);await withTenant(db,f.organizationId,async tx=>{const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"property:view"}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_team_property_view_"+randomUUID(),name:"Actual independent Property visibility",rolePermissions:{create:{organizationId:f.organizationId,permissionId:permission.id}}}});f.grants["property:view"]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}})).id;});f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};return f;
}
export async function nativeOnboardingTeamSourceAssignment(f:NativeOnboardingTeamSourceFixture,db:PrismaClient,changes:Partial<Prisma.RoleAssignmentUncheckedCreateInput>={}){
 return withTenant(db,f.organizationId,tx=>tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.staff.id,userAccountId:f.staffAccount.id,roleId:f.role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01"),createdBy:f.account.id,conditions:{assignedToMe:true},compensationRef:"Private financial reference must not be read",...changes}}));
}
