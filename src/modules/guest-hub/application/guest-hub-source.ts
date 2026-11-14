import {ZodError} from "zod";
import type {GuestHubLink} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubLinkPolicyKey,guestHubLinkPolicySchema,GuestHubConfigurationError,guestHubLinkState} from "../domain/guest-hub-policy";
import type {GuestHubPayloadBinding} from "../domain/guest-hub-payload";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";

export function guestHubSourceSnapshot(organizationId:string,source:GuestHubNativeSource){
 return{protocol:"NATIVE_GUEST_LINK_SOURCE_V1",organizationId,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,
  reservationVersion:source.reservationVersion,reservationTuple:source.reservationTuple,reservationNumber:source.reservationNumber,
  propertyVersion:source.propertyVersion,propertyTuple:source.propertyTuple,guestVersion:source.guestVersion,guestTuple:source.guestTuple,
  checkOut:source.checkOut.toISOString().slice(0,10),timezone:source.timezone};
}
export async function guestHubSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){
 try{
  const scopes=await new ReservationConfigScopeRepository(tx,organizationId).scopes({propertyId:source.propertyId,source:source.bookingSource,asOf:now});
  const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:guestHubLinkPolicyKey,scopes,asOf:now});
  if(!rule?.createdBy||rule.lifecycle!=="ACTIVE")throw new GuestHubConfigurationError();
  const policy=guestHubLinkPolicySchema.parse(rule.parsedValue),snapshot={id:rule.id,version:rule.version,value:rule.value};
  return{rule,policy,snapshot,fingerprint:jsonbFingerprint(snapshot)};
 }catch(error){if(error instanceof ZodError)throw new GuestHubConfigurationError();throw error;}
}
export function guestHubOriginalBinding(row:GuestHubLink):GuestHubPayloadBinding{
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint)throw new GuestHubConfigurationError();
 return{organizationId:row.organizationId,linkId:row.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,issuedAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),createdBy:row.createdBy,policyId:row.policyId,policyVersion:row.policyVersion,commandKey:row.commandKey,commandHash:row.commandHash,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,tokenHash:row.tokenHash};
}
export function currentGuestHubState(row:GuestHubLink,source:GuestHubNativeSource,settings:Awaited<ReturnType<typeof guestHubSettings>>,revoked:boolean,now:Date){
 return guestHubLinkState({policy:settings.policy,issuedAt:row.createdAt,recordedExpiresAt:row.expiresAt,currentCheckoutDay:source.checkOut.toISOString().slice(0,10),propertyTimezone:source.timezone,now,revoked,reservationStatus:source.reservationStatus,sourceAvailable:source.sourceAvailable&&source.propertyId===row.propertyId,guestSourceMatches:source.guestId===row.guestId});
}
