import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {createManualReservation} from "@/modules/reservations/application/reservation-service";
import {guestHubLinkPolicyKey,guestHubVerificationPolicyKey,type GuestHubLinkPolicy} from "@/modules/guest-hub/domain/guest-hub-policy";

export async function nativeGuestHubFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<GuestHubLinkPolicy>={}){
 const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Owned native Guest Hub acceptance"}});await ensureStandardIdentitySetup(organizationId,{db:admin});
 const saved=await withTenant(db,organizationId,async tx=>{
  const person=await tx.person.create({data:{organizationId,displayName:"Owned Guest Hub operator"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}}),region=await tx.region.create({data:{organizationId,name:"Owned Guest Hub region"}}),city=await tx.city.create({data:{organizationId,regionId:region.id,name:"Owned Guest Hub city"}}),property=await tx.property.create({data:{organizationId,name:"Owned Guest Hub property",addressLine1:"Private owned address",city:city.name,cityId:city.id,regionId:region.id,timezone:"Africa/Casablanca",propertyType:"VILLA",bedrooms:2,bathrooms:2,maxGuests:4,amenities:[],photoUrls:[]}}),grants:Record<string,string>={};
  for(const key of["reservation:create","task:create","guest:create","reservation:view","guest:view","guest_hub:view","guest_hub:create","guest_hub:void"]){
   const permission=await tx.permission.findFirstOrThrow({where:{organizationId,key}}),role=await tx.role.create({data:{organizationId,key:"native_guest_"+randomUUID(),name:"Independent Guest Hub "+key}});await tx.rolePermission.create({data:{organizationId,roleId:role.id,permissionId:permission.id}});
   const assignment=await tx.roleAssignment.create({data:{organizationId,personId:person.id,userAccountId:account.id,roleId:role.id,scopeType:key.endsWith(":create")&&!key.startsWith("guest_hub:")?"organization":"property",scopeId:key.endsWith(":create")&&!key.startsWith("guest_hub:")?null:property.id,validFrom:new Date("2020-01-01")}});grants[key]=assignment.id;
  }
  const policy:GuestHubLinkPolicy={source:"NATIVE_RESERVATION_GUEST_LINKS",enabled:true,signature:"PURPOSE_BOUND_VERSIONED_KEY_RING",history:"APPEND_ONLY_GUEST_LINK_HISTORY",checkout_local_time:"11:00",checkout_grace_seconds:3600,allowed_reservation_states:["CONFIRMED","GUEST_PREPARATION","CHECKED_IN","STAYING"],processing_approval_reference:"Explicit owned-test Guest Hub processing decision",issuance:{requests:100,window_seconds:3600},reads:{requests:100,window_seconds:3600},...changes},rules=new ConfigRuleRepository(tx,organizationId);
  for(const[key,value]of Object.entries({[guestHubLinkPolicyKey]:policy,[guestHubVerificationPolicyKey]:{source:"NATIVE_GUEST_CAPABILITY_VERIFICATION",enabled:true,checks:{requests:1000,window_seconds:3600},clients:{requests:1000,window_seconds:3600}},"ops.reservation_task_templates":{tasks:[{key:"arrival",type:"ARRIVAL_PREPARATION",due:"CHECK_IN",title:{en:"Owned native arrival",fr:"Arrivée native contrôlée",ar:"وصول أصلي للاختبار"},checklist:[{key:"ready",label:{en:"Ready",fr:"Prêt",ar:"جاهز"}}]}]},"finance.commission":{rate_bps:2000,basis:"GROSS_ACCOMMODATION",accrual_event:"ON_CHECKOUT"}}))await rules.createVersion({key,scopeType:"organization",scopeId:null,createdBy:account.id,effectiveFrom:new Date("2020-01-01"),value,reason:"Explicit owned native Guest Hub acceptance configuration"});
  return{person,account,property,grants,policy};
 });
 const ctx={organizationId,actorId:saved.account.id,personId:saved.person.id,authContext:{...await authContextForAccount(organizationId,saved.account.id,{db}),personId:saved.person.id}},booking=await createManualReservation(ctx,{propertyId:saved.property.id,source:"DIRECT",guestName:"Private canonical Guest Hub guest",guestEmail:"native-guest-"+randomUUID()+"@example.test",guestPreferredLocale:"fr",checkIn:"2031-05-01",checkOut:"2031-05-04",adultCount:1,childCount:0,idempotencyKey:randomUUID()},{db,requestId:randomUUID(),ipAddress:null});
 const reservation=await withTenant(db,organizationId,tx=>tx.reservation.findUniqueOrThrow({where:{id:booking.reservation.id}}));if(!reservation.guestId)throw Error("Actual reservation producer must attach its canonical guest");
 return{organizationId,...saved,ctx,reservation};
}

export async function nativeGuestHubSecondActor(db:PrismaClient,f:Awaited<ReturnType<typeof nativeGuestHubFixture>>){
 const saved=await withTenant(db,f.organizationId,async tx=>{const person=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Independent authorized original-key non-creator"}}),account=await tx.userAccount.create({data:{organizationId:f.organizationId,personId:person.id}});for(const id of Object.values(f.grants)){const original=await tx.roleAssignment.findUniqueOrThrow({where:{id}});await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:account.id,personId:person.id,roleId:original.roleId,scopeType:original.scopeType,scopeId:original.scopeId,validFrom:original.validFrom}});}return{person,account};});return{organizationId:f.organizationId,actorId:saved.account.id,authContext:{...await authContextForAccount(f.organizationId,saved.account.id,{db}),personId:saved.person.id}};
}
