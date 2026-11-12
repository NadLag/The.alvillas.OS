import type {NativeOnboardingFixtureIdentity} from "./onboarding-fixture";
import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {reviewOnboardingBookingChannelsStep,admitOnboardingBookingChannelsStep} from "@/modules/onboarding/application/onboarding-service";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {savePropertyTemplate} from "@/modules/core/application/property-template-service";
import {nativeOnboardingBookingChannelsFixture} from "./onboarding-booking-channels-fixture";

export function nativeInventoryItem(){return{item:"bath_towel",quantity:2,name:{en:"Original bath towel",fr:"Serviette originale",ar:"منشفة أصلية"},unit:"piece",category:"LINEN"as const,expected_per_stay:null};}
/** Every predecessor is a real canonical source plus immutable native admission; no seed-only wizard progress. */
export async function nativeOnboardingInventoryFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,identity?:NativeOnboardingFixtureIdentity){
 const f=await nativeOnboardingBookingChannelsFixture(admin,db,env,identity),review=await reviewOnboardingBookingChannelsStep(f.ctx,f.channelDraft,f.deps),book=await admitOnboardingBookingChannelsStep(f.ctx,{...f.channelDraft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual native channel predecessor for Inventory acceptance"},f.deps),policy=onboardingPolicySchema.parse({...f.policy,inventory:{modes:["TEMPLATE","CUSTOM"],minimum_items:1}});
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit approved native Inventory modes and minimum"}));
 return{...f,book,policy,inventoryTarget:{mode:"CUSTOM"as const,propertyId:book.propertyId!,settings:{minimums:[nativeInventoryItem()]}}};
}
export type NativeOnboardingInventoryFixture=Awaited<ReturnType<typeof nativeOnboardingInventoryFixture>>;
export async function nativeInventoryTemplate(f:NativeOnboardingInventoryFixture,db:PrismaClient,propertyId:string|null=null){
 const {expected_per_stay,...item}=nativeInventoryItem();void expected_per_stay;
 return withTenant(db,f.organizationId,tx=>savePropertyTemplate({...f.ctx,personId:f.person.id},{key:"native_inventory_"+randomUUID(),kind:"INVENTORY",propertyId,name:{en:"Original private Inventory template",fr:"Modèle privé original"},description:{en:"Actual canonical Inventory source",fr:"Source canonique réelle"},values:{rules:{"inventory.minimums":{minimums:[item]}}},status:"ACTIVE",expectedVersion:0,reason:"Actual approved canonical Inventory template"},{db:{$transaction:work=>work(tx)},requestId:randomUUID()}));
}
