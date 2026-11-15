import type {GuestHubFormGrant,GuestHubProfileRevision} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubProfilePayloadBindingSchema} from "../domain/guest-hub-profile-payload";
import {guestHubProfilePolicyKey,guestHubProfilePolicySchema,effectiveGuestHubProfilePolicy,GuestHubProfileAccessError} from "../domain/guest-hub-profile-policy";
import {GuestHubProfileRepository} from "../infrastructure/guest-hub-profile-repository";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";
import {guestHubFormSettings,activeGuestHubForm,guestHubFormGrantBinding as formBinding,authenticateGuestHubFormGrant as authenticateForm} from "./guest-hub-form-source";
const policyDefinition={policyKey:guestHubProfilePolicyKey,parsePolicy:(raw:unknown)=>guestHubProfilePolicySchema.parse(raw),assertPolicy:effectiveGuestHubProfilePolicy,AccessError:GuestHubProfileAccessError};
export function guestHubProfileSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){return guestHubFormSettings(tx,organizationId,source,now,policyDefinition);}
export function guestHubFormGrantBinding(row:GuestHubFormGrant){return formBinding(row,GuestHubProfileAccessError);}
export function authenticateGuestHubFormGrant(row:GuestHubFormGrant,env:NodeJS.ProcessEnv=process.env){return authenticateForm(row,env,GuestHubProfileAccessError);}
export function guestHubProfileRevisionBinding(row:GuestHubProfileRevision){
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint)throw new GuestHubProfileAccessError();
 return guestHubProfilePayloadBindingSchema.parse({protocol:"NATIVE_GUEST_PROFILE_PAYLOAD_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,grantId:row.grantId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,commandKey:row.commandKey,commandHash:row.commandHash,commandKeyVersion:row.commandKeyVersion,grantFingerprint:row.grantFingerprint,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,createdAt:row.createdAt.toISOString()});
}
export async function activeGuestHubProfile(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,env:NodeJS.ProcessEnv=process.env,head?:GuestHubFormGrant|null){const active=await activeGuestHubForm(context,{formKey:"PROFILE",settings:guestHubProfileSettings,parsePolicy:policyDefinition.parsePolicy,effectivePolicy:effectiveGuestHubProfilePolicy,AccessError:GuestHubProfileAccessError},env,head);return{...active,repository:new GuestHubProfileRepository(context.tx,context.actual.row.organizationId)};}
