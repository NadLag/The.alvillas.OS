import type {NativeOnboardingFixtureIdentity} from "./onboarding-fixture";
import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {reviewOnboardingInventoryStep,admitOnboardingInventoryStep} from "@/modules/onboarding/application/onboarding-service";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {savePropertyTemplate} from "@/modules/core/application/property-template-service";
import {canonicalOnboardingServicesSettings} from "@/platform/onboarding/contracts";
import {nativeOnboardingInventoryFixture} from "./onboarding-inventory-fixture";

export function nativeService(){return{key:"airport_transfer",name:{en:"Original airport transfer",fr:"Transfert aéroport original",ar:"نقل أصلي من المطار"},description:null,available:false,pricing_model:"FIXED"as const,amount:"0.00",currency:"MAD"};}
/** Seven actual admitted canonical predecessors; services never come from seeded wizard progress. */
export async function nativeOnboardingServicesFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,identity?:NativeOnboardingFixtureIdentity){
 const f=await nativeOnboardingInventoryFixture(admin,db,env,identity),inventoryDraft={sessionId:f.book.sessionId,previousRevisionId:f.book.id,step:"INVENTORY",target:f.inventoryTarget},review=await reviewOnboardingInventoryStep(f.ctx,inventoryDraft,f.deps),inventory=await admitOnboardingInventoryStep(f.ctx,{...inventoryDraft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual Inventory predecessor for original Services acceptance"},f.deps),policy=onboardingPolicySchema.parse({...f.policy,services:{modes:["LINK","TEMPLATE","CUSTOM"],minimum_services:1}});
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit approved native Services modes and required count"}));
 return{...f,inventory,policy,servicesTarget:{mode:"CUSTOM"as const,propertyId:inventory.propertyId!,settings:{services:[nativeService()]}}};
}
export type NativeOnboardingServicesFixture=Awaited<ReturnType<typeof nativeOnboardingServicesFixture>>;
export function nativeServicesTemplate(f:NativeOnboardingServicesFixture,db:PrismaClient,propertyId:string|null=null){return withTenant(db,f.organizationId,tx=>savePropertyTemplate({...f.ctx,personId:f.person.id},{key:"native_services_"+randomUUID(),kind:"SERVICE_CATALOG",propertyId,name:{en:"Original private service catalog",fr:"Catalogue de services privé"},values:{rules:{"services.pricing":canonicalOnboardingServicesSettings({services:[nativeService()]})}},status:"ACTIVE",expectedVersion:0,reason:"Actual independently authorized canonical service catalog"},{db:{$transaction:work=>work(tx)},requestId:randomUUID()}));}
