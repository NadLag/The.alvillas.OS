import type {GuestHubFormGrant,GuestHubProfileRevision} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubFormGrantBindingSchema} from "../domain/guest-hub-profile-contract";
import {guestHubProfilePayloadBindingSchema} from "../domain/guest-hub-profile-payload";
import {guestHubProfilePolicyKey,guestHubProfilePolicySchema,effectiveGuestHubProfilePolicy,GuestHubProfileAccessError} from "../domain/guest-hub-profile-policy";
import {verifyGuestHubFormGrant} from "../domain/guest-hub-profile-signatures";
import {GuestHubProfileRepository} from "../infrastructure/guest-hub-profile-repository";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubSourceSnapshot} from "./guest-hub-source";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";

export async function guestHubProfileSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){
 const scopes=await new ReservationConfigScopeRepository(tx,organizationId).scopes({propertyId:source.propertyId,source:source.bookingSource,asOf:now});
 const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:guestHubProfilePolicyKey,scopes,asOf:now});
 if(!rule?.createdBy||rule.lifecycle!=="ACTIVE")throw new GuestHubProfileAccessError();
 const policy=guestHubProfilePolicySchema.parse(rule.parsedValue),snapshot={id:rule.id,version:rule.version,value:rule.value};
 effectiveGuestHubProfilePolicy(policy,policy);return{rule,policy,snapshot,fingerprint:jsonbFingerprint(snapshot)};
}
export function guestHubFormGrantBinding(row:GuestHubFormGrant){
 if(jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint||row.decision==="GRANTED"&&jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint)throw new GuestHubProfileAccessError();
 return guestHubFormGrantBindingSchema.parse({protocol:"NATIVE_GUEST_FORM_GRANT_V1",formKey:row.formKey,id:row.id,organizationId:row.organizationId,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,decision:row.decision,linkTokenHash:row.linkTokenHash,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,createdBy:row.createdBy,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),commandKey:row.commandKey,commandHash:row.commandHash});
}
export function authenticateGuestHubFormGrant(row:GuestHubFormGrant,env:NodeJS.ProcessEnv=process.env){
 const binding=guestHubFormGrantBinding(row);if(!/^[a-f0-9]{64}$/u.test(row.signature)||!verifyGuestHubFormGrant(binding,row.signatureVersion,Buffer.from(row.signature,"hex"),env))throw new GuestHubProfileAccessError();
 return{binding,fingerprint:jsonbFingerprint({binding,signatureVersion:row.signatureVersion,signature:row.signature})};
}
export function guestHubProfileRevisionBinding(row:GuestHubProfileRevision){
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint)throw new GuestHubProfileAccessError();
 return guestHubProfilePayloadBindingSchema.parse({protocol:"NATIVE_GUEST_PROFILE_PAYLOAD_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,grantId:row.grantId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,commandKey:row.commandKey,commandHash:row.commandHash,commandKeyVersion:row.commandKeyVersion,grantFingerprint:row.grantFingerprint,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,createdAt:row.createdAt.toISOString()});
}
/** A read capability acquires only this form's explicitly signed, currently retained authority. */
export async function activeGuestHubProfile(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,env:NodeJS.ProcessEnv=process.env){
 const {tx,actual}=context,{row,source}=actual,repository=new GuestHubProfileRepository(tx,row.organizationId),grant=await repository.grantHead(row.id);
 if(!grant)throw new GuestHubProfileAccessError();const authenticated=authenticateGuestHubFormGrant(grant,env),now=await actual.repository.clock();
 if(grant.decision!=="GRANTED"||grant.organizationId!==row.organizationId||grant.linkId!==row.id||grant.reservationId!==row.reservationId||grant.propertyId!==row.propertyId||grant.guestId!==row.guestId||grant.linkTokenHash!==row.tokenHash||grant.createdAt<row.createdAt||grant.createdAt>now||grant.expiresAt.getTime()!==row.expiresAt.getTime()||grant.expiresAt<=now)throw new GuestHubProfileAccessError();
 const settings=await guestHubProfileSettings(tx,row.organizationId,source,now),captured=guestHubProfilePolicySchema.parse((grant.policySnapshot as {value:unknown}).value),policy=effectiveGuestHubProfilePolicy(captured,settings.policy),sourceSnapshot=guestHubSourceSnapshot(row.organizationId,source),sourceFingerprint=jsonbFingerprint(sourceSnapshot);
 return{repository,grant,grantFingerprint:authenticated.fingerprint,settings,policy,sourceSnapshot,sourceFingerprint,now,
  fingerprint:jsonbFingerprint({grant:authenticated.fingerprint,policy:settings.fingerprint,source:sourceFingerprint})};
}
