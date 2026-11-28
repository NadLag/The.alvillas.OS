import {ZodError} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository,type ConfigScopeCandidate} from "@/platform/config/config-rule-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubHomeSchema,guestHubCalendarStage,guestHubPublicPhoto,guestHubPresentationPolicyKey,guestHubPresentationPolicySchema,type GuestHubPresentationPolicy} from "../domain/guest-hub-presentation";
import { guestHubPropertyInformationKey, type GuestHubPropertyInformation } from "../domain/guest-hub-property-information";
import { readGuestHubPropertyInformation } from "./guest-hub-property-information";

/** Resolve only after the signed native source has passed its independent read authority. */
export async function guestHubHome(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,scopes:ConfigScopeCandidate[],now:Date,env?:NodeJS.ProcessEnv){
 const repository = new ConfigRuleRepository(tx, organizationId);
 const calendarStage = guestHubCalendarStage(source.checkIn.toISOString().slice(0,10),source.checkOut.toISOString().slice(0,10),source.timezone,now);
 const [rule, propertyRule] = await Promise.all([
   repository.resolve({key:guestHubPresentationPolicyKey,scopes,asOf:now}),
   calendarStage === "PAST" ? null : repository.resolveMetadata({
     key: guestHubPropertyInformationKey, scopes: [{ scopeType: "property", scopeId: source.propertyId }], asOf: now
   })
 ]);
 let policy:GuestHubPresentationPolicy|null=null;
 if(rule?.createdBy&&rule.lifecycle==="ACTIVE"){try{policy=guestHubPresentationPolicySchema.parse(rule.parsedValue);}catch(error){if(!(error instanceof ZodError))throw error;}}
 let propertyInformation: GuestHubPropertyInformation | undefined;
 if (propertyRule?.createdBy && propertyRule.lifecycle === "ACTIVE") {
   const value = await repository.findById(propertyRule.id);
   if (value?.scopeType === "property" && value.scopeId === source.propertyId && value.key === guestHubPropertyInformationKey) {
     try {
       const { wifi, ...shared } = readGuestHubPropertyInformation(value.value, organizationId, source.propertyId, env);
       const information = wifi && calendarStage !== "UPCOMING" ? { ...shared, wifi } : shared;
       if (Object.keys(information).length) propertyInformation = information;
     } catch {
       // A missing key or malformed envelope must never disclose guest information.
     }
   }
 }
 const photoPolicy = rule && {id:rule.id,version:rule.version,lifecycle:rule.lifecycle,value:rule.value};
 return{fingerprint:jsonbFingerprint({photoPolicy, propertyRule: propertyRule?.id ?? null, propertyInformation: propertyInformation ?? null}),
  data:guestHubHomeSchema.parse({propertyName:source.propertyName,photoUrl:guestHubPublicPhoto(source.photoUrls,policy),adultCount:source.adultCount,childCount:source.childCount,checkedAt:now.toISOString(),calendarStage, ...propertyInformation && { propertyInformation }})};
}
