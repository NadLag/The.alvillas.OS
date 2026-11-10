import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeOnboardingPropertyHeads} from "@/platform/onboarding/property-source";
import {nativeOnboardingBookingChannelHeads,nativeOnboardingBookingChannelRows,nativeOnboardingBookingChannelPins,nativeOnboardingBookingChannelProjection} from "@/platform/onboarding/booking-channels-source";
import {onboardingBookingChannelsTargetSchema,onboardingBookingChannelSourcePinsSchema} from "../domain/onboarding-booking-channels";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";

/** Metadata first. Current original-Property authority does not require financial export or private Management reads. */
export async function onboardingBookingChannelSourceContext(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,includeArchived=false){
 const [property]=await nativeOnboardingPropertyHeads(tx,actor.organizationId,[propertyId],includeArchived);if(!property)throw new OnboardingAccessError();
 const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new OnboardingRepository(tx,actor.organizationId).clock();
 assertAccountAuthorization(actor,stored,now,[{action:"view",resource:{type:"property",organizationId:actor.organizationId,id:property.id,propertyId:property.id,city:property.cityId,region:property.regionId,status:property.status,occurredAt:property.createdAt}}],new OnboardingAccessError());
 return{property,stored,now};
}
async function metadata(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown,recorded=false){
 const target=onboardingBookingChannelsTargetSchema.parse(raw);if(target.propertyId!==propertyId)throw new OnboardingAccessError();
 const{property}=await onboardingBookingChannelSourceContext(actor,tx,propertyId,recorded);
 const channels=await nativeOnboardingBookingChannelHeads(tx,actor.organizationId,propertyId,target.mode==="LINK"?{ids:target.channelIds}:{sourceKeys:target.channels.map(row=>row.sourceKey)},recorded||target.mode==="CONFIGURE");
 if(target.mode==="LINK"&&channels.length!==target.channelIds.length)throw new OnboardingAccessError();
 return{target,channels,pins:nativeOnboardingBookingChannelPins(channels),fingerprint:commandFingerprint({property,channels})};
}

/** Parent session, Owner checks, policy and read audit are retained by the caller. No credential is loaded here. */
export async function readOnboardingBookingChannelSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown){
 const before=await metadata(actor,tx,propertyId,raw),rows=await nativeOnboardingBookingChannelRows(tx,actor.organizationId,propertyId,before.channels.map(row=>row.id),before.target.mode==="CONFIGURE"),after=await metadata(actor,tx,propertyId,raw);
 if(before.fingerprint!==after.fingerprint||rows.length!==before.channels.length)throw new OnboardingConflictError();
 return{target:before.target,pins:before.pins,sourceFingerprint:before.fingerprint,snapshot:nativeOnboardingBookingChannelProjection(propertyId,rows)};
}

/** History authorizes the original identities without loading corrected configuration or endpoints. */
export async function authorizeRecordedOnboardingBookingChannelSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown){
 const pins=onboardingBookingChannelSourcePinsSchema.parse(raw);if(pins.some(row=>row.propertyId!==propertyId))throw new OnboardingAccessError();
 const value=await metadata(actor,tx,propertyId,{mode:"LINK",propertyId,channelIds:pins.map(row=>row.id)},true);return{fingerprint:value.fingerprint};
}
