import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {previewServiceCatalogChange,publishServiceCatalogChange} from "@/modules/services/application/service-catalog-service";
import {nativeServiceCatalogFixture} from "./service-catalog-fixture";
import type {NativeGuestHubFixtureIdentity} from "./guest-hub-fixture";

export async function nativeServiceOrderFixture(admin:PrismaClient,db:PrismaClient,identity?:NativeGuestHubFixtureIdentity){
 const f=await nativeServiceCatalogFixture(admin,db,identity),grants={...f.grants};
 await withTenant(db,f.organizationId,async tx=>{
  for(const key of[...["view","create","edit","approve","void","reject","validate"].map(action=>"service_order:"+action),"task:view","task:edit","task:assign","task:validate"]){
   const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"service_order_"+randomUUID(),name:"Independent owned service order "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});
   const grant=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});grants[key]=grant.id;
  }
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"services.ordering",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit fictional native order request policy",value:{schemaVersion:1,max_quantity:10,max_service_days:10,participant_basis:"SELECTED_RESERVATION_GUESTS",date_basis:"INCLUSIVE_RESERVATION_DATES"}});
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"ops.checklists",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit fictional native service checklist",value:{checklists:[{key:"owned_service",name:f.entry.name,items:[{key:"complete",label:f.entry.name}]}]}});
 });
 const ctx={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},draft={...f.draft,entry:{...f.entry,order_terms:{...f.entry.order_terms,availability:{path:"property.cityId",op:"!=",value:null}}}},catalogReview=await previewServiceCatalogChange(ctx,draft,f.deps);
 await publishServiceCatalogChange(ctx,{draft,reviewFingerprint:catalogReview.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);
 const request={propertyId:f.property.id,reservationId:f.reservation.id,serviceKey:f.entry.key,serviceDate:f.reservation.checkIn.toISOString().slice(0,10),lastServiceDate:f.reservation.checkIn.toISOString().slice(0,10),quantity:2,guests:1,reason:"Actual private service order reason with agreed total 240.00"};
 return{...f,ctx,grants,request};
}
