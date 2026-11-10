import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {reviewOnboardingTeamStep,admitOnboardingTeamStep} from "@/modules/onboarding/application/onboarding-service";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {nativeOnboardingTeamFixture} from "./onboarding-team-fixture";

/** Every predecessor is admitted through its real canonical source, audit and immutable native history. */
export async function nativeOnboardingBookingChannelsFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv){
 const f=await nativeOnboardingTeamFixture(admin,db,env),review=await reviewOnboardingTeamStep(f.ctx,f.teamDraft,f.deps),team=await admitOnboardingTeamStep(f.ctx,{...f.teamDraft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual saved operational Team predecessor for native channels"},f.deps),policy=onboardingPolicySchema.parse({...f.policy,booking_channels:{modes:["LINK","CONFIGURE"],minimum_channels:1}});
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit approved native channel modes and minimum"}));
 return{...f,policy,team,channelDraft:{sessionId:team.sessionId,previousRevisionId:team.id,step:"BOOKING_CHANNELS"as const,target:{mode:"CONFIGURE"as const,propertyId:team.propertyId!,channels:[{sourceKey:"AIRBNB",displayName:"Original private native channel",externalListingId:null,listingUrl:null,syncMode:"ICAL"as const,importEnabled:false,exportEnabled:false,syncEndpointUrl:"https://calendar.example.test/original.ics?token=owned-review-fixture"as string|null,status:"PAUSED"as const}]}}};
}
