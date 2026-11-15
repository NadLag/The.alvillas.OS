import {ZodError} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository,type ConfigScopeCandidate} from "@/platform/config/config-rule-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubHomeSchema,guestHubCalendarStage,guestHubPublicPhoto,guestHubPresentationPolicyKey,guestHubPresentationPolicySchema,type GuestHubPresentationPolicy} from "../domain/guest-hub-presentation";

/** Resolve only after the signed native source has passed its independent read authority. */
export async function guestHubHome(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,scopes:ConfigScopeCandidate[],now:Date){
 const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:guestHubPresentationPolicyKey,scopes,asOf:now});let policy:GuestHubPresentationPolicy|null=null;
 if(rule?.createdBy&&rule.lifecycle==="ACTIVE"){try{policy=guestHubPresentationPolicySchema.parse(rule.parsedValue);}catch(error){if(!(error instanceof ZodError))throw error;}}
 return{fingerprint:rule?jsonbFingerprint({id:rule.id,version:rule.version,lifecycle:rule.lifecycle,value:rule.value}):null,
  data:guestHubHomeSchema.parse({propertyName:source.propertyName,photoUrl:guestHubPublicPhoto(source.photoUrls,policy),adultCount:source.adultCount,childCount:source.childCount,checkedAt:now.toISOString(),calendarStage:guestHubCalendarStage(source.checkIn.toISOString().slice(0,10),source.checkOut.toISOString().slice(0,10),source.timezone,now)})};
}
