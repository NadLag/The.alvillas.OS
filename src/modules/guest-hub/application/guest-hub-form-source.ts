import type {GuestHubFormGrant} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubFormGrantBindingSchema,type GuestHubFormKey} from "../domain/guest-hub-form-grant-contract";
import {verifyGuestHubFormGrant} from "../domain/guest-hub-form-grant-signatures";
import {GuestHubFormGrantRepository} from "../infrastructure/guest-hub-form-grant-repository";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubSourceSnapshot} from "./guest-hub-source";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";

type ErrorConstructor=new()=>Error;
export async function guestHubFormSettings<Policy>(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date,definition:{policyKey:string;parsePolicy:(raw:unknown)=>Policy;assertPolicy:(original:Policy,current:Policy)=>unknown;AccessError:ErrorConstructor}){
 const scopes=await new ReservationConfigScopeRepository(tx,organizationId).scopes({propertyId:source.propertyId,source:source.bookingSource,asOf:now}),rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:definition.policyKey,scopes,asOf:now});
 if(!rule?.createdBy||rule.lifecycle!=="ACTIVE")throw new definition.AccessError();const policy=definition.parsePolicy(rule.parsedValue),snapshot={id:rule.id,version:rule.version,value:rule.value};definition.assertPolicy(policy,policy);return{rule,policy,snapshot,fingerprint:jsonbFingerprint(snapshot)};
}
export function guestHubFormGrantBinding(row:GuestHubFormGrant,AccessError:ErrorConstructor){
 if(jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint||row.decision==="GRANTED"&&jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint)throw new AccessError();
 return guestHubFormGrantBindingSchema.parse({protocol:"NATIVE_GUEST_FORM_GRANT_V1",formKey:row.formKey,id:row.id,organizationId:row.organizationId,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,decision:row.decision,linkTokenHash:row.linkTokenHash,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,createdBy:row.createdBy,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),commandKey:row.commandKey,commandHash:row.commandHash});
}
export function authenticateGuestHubFormGrant(row:GuestHubFormGrant,env:NodeJS.ProcessEnv,AccessError:ErrorConstructor){const binding=guestHubFormGrantBinding(row,AccessError);if(!/^[a-f0-9]{64}$/u.test(row.signature)||!verifyGuestHubFormGrant(binding,row.signatureVersion,Buffer.from(row.signature,"hex"),env))throw new AccessError();return{binding,fingerprint:jsonbFingerprint({binding,signatureVersion:row.signatureVersion,signature:row.signature})};}
export async function activeGuestHubForm<Policy,Effective>(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,definition:{formKey:GuestHubFormKey;settings:(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date)=>Promise<Awaited<ReturnType<typeof guestHubFormSettings<Policy>>>>;parsePolicy:(raw:unknown)=>Policy;effectivePolicy:(original:Policy,current:Policy)=>Effective;AccessError:ErrorConstructor},env:NodeJS.ProcessEnv=process.env,providedHead?:GuestHubFormGrant|null){
 const {tx,actual}=context,{row,source}=actual,grant=providedHead===undefined?await new GuestHubFormGrantRepository(tx,row.organizationId,definition.formKey).grantHead(row.id):providedHead;if(!grant||grant.formKey!==definition.formKey)throw new definition.AccessError();const authenticated=authenticateGuestHubFormGrant(grant,env,definition.AccessError),now=await actual.repository.clock();
 if(grant.decision!=="GRANTED"||grant.organizationId!==row.organizationId||grant.linkId!==row.id||grant.reservationId!==row.reservationId||grant.propertyId!==row.propertyId||grant.guestId!==row.guestId||grant.linkTokenHash!==row.tokenHash||grant.createdAt<row.createdAt||grant.createdAt>now||grant.expiresAt.getTime()!==row.expiresAt.getTime()||grant.expiresAt<=now)throw new definition.AccessError();
 const settings=await definition.settings(tx,row.organizationId,source,now),captured=definition.parsePolicy((grant.policySnapshot as {value:unknown}).value),policy=definition.effectivePolicy(captured,settings.policy),sourceSnapshot=guestHubSourceSnapshot(row.organizationId,source),sourceFingerprint=jsonbFingerprint(sourceSnapshot);
 return{grant,grantFingerprint:authenticated.fingerprint,settings,policy,sourceSnapshot,sourceFingerprint,now,fingerprint:jsonbFingerprint({grant:authenticated.fingerprint,policy:settings.fingerprint,source:sourceFingerprint})};
}
