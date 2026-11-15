import type {GuestHubFormGrant,GuestHubHouseRulesAcceptance} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {GuestHubHouseRulesRepository} from "../infrastructure/guest-hub-house-rules-repository";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubHouseRulesPolicyKey,guestHubHouseRulesPolicySchema,effectiveGuestHubHouseRulesPolicy,GuestHubHouseRulesAccessError} from "../domain/guest-hub-house-rules-policy";
import {approvedGuestHubHouseRulesSource} from "../domain/guest-hub-house-rules-source";
import {guestHubHouseRulesPayloadBindingSchema} from "../domain/guest-hub-house-rules-contract";
import {GuestHubAccessError} from "../domain/guest-hub-policy";
import {guestHubFormSettings,activeGuestHubForm} from "./guest-hub-form-source";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";

const definition={policyKey:guestHubHouseRulesPolicyKey,parsePolicy:(raw:unknown)=>guestHubHouseRulesPolicySchema.parse(raw),assertPolicy:effectiveGuestHubHouseRulesPolicy,AccessError:GuestHubHouseRulesAccessError};
export async function guestHubHouseRulesSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){
 const settings=await guestHubFormSettings(tx,organizationId,source,now,definition),original=await new GuestHubHouseRulesRepository(tx,organizationId).canonicalRules(source.propertyId);if(!original)throw new GuestHubHouseRulesAccessError();approvedGuestHubHouseRulesSource(effectiveGuestHubHouseRulesPolicy(settings.policy,settings.policy),organizationId,source.propertyId,original.rules);return settings;
}
export function guestHubHouseRulesAcceptanceBinding(row:GuestHubHouseRulesAcceptance){
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint||jsonbFingerprint(row.rulesSnapshot)!==row.rulesFingerprint)throw new GuestHubHouseRulesAccessError();
 return guestHubHouseRulesPayloadBindingSchema.parse({protocol:"NATIVE_GUEST_HOUSE_RULES_PAYLOAD_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,grantId:row.grantId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,commandKey:row.commandKey,commandHash:row.commandHash,commandKeyVersion:row.commandKeyVersion,grantFingerprint:row.grantFingerprint,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,rulesFingerprint:row.rulesFingerprint,editionFingerprint:row.editionFingerprint,renderedFingerprint:row.renderedFingerprint,requestedLocale:row.requestedLocale,displayedLocale:row.displayedLocale,createdAt:row.createdAt.toISOString()});
}
export async function activeGuestHubHouseRules(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,env:NodeJS.ProcessEnv=process.env,head?:GuestHubFormGrant|null){
 const active=await activeGuestHubForm(context,{formKey:"HOUSE_RULES",settings:guestHubHouseRulesSettings,parsePolicy:definition.parsePolicy,effectivePolicy:effectiveGuestHubHouseRulesPolicy,AccessError:GuestHubHouseRulesAccessError},env,head),{tx,actual}=context,actor={organizationId:actual.row.organizationId,actorId:active.grant.createdBy,authContext:restoreAuthorizationCap(active.grant.authorizationCap)},linkTarget=await guestHubLinkTarget(actual.repository,actual.row,actual.source),target=guestHubResource(actor.organizationId,actual.source,linkTarget),personal={...guestHubResource(actor.organizationId,actual.source),type:"guest",id:actual.source.guestId,dataClass:"personal" as const,occurredAt:actual.source.guestCreatedAt};
 try{await requireGuestHubStaffAuthority(actor,tx,actual.source,"create",active.now,linkTarget);await recheckAccountAuthorization(actor,tx,active.now,[{action:"view",resource:{...target,type:"guest_hub_house_rules"}},{action:"create",resource:{...target,type:"guest_hub_house_rules"}},{action:"view",resource:personal},{action:"edit",resource:personal}],new GuestHubHouseRulesAccessError());}catch(error){if(error instanceof GuestHubAccessError)throw new GuestHubHouseRulesAccessError();throw error;}
 const repository=new GuestHubHouseRulesRepository(tx,actor.organizationId),original=await repository.canonicalRules(actual.source.propertyId);if(!original)throw new GuestHubHouseRulesAccessError();const approved=approvedGuestHubHouseRulesSource(active.policy,actor.organizationId,actual.source.propertyId,original.rules);
 return{...active,repository,rulesSnapshot:approved.source,rulesFingerprint:approved.sourceFingerprint,editionFingerprint:approved.editionFingerprint,fingerprint:jsonbFingerprint({form:active.fingerprint,rules:approved.sourceFingerprint,edition:approved.editionFingerprint})};
}
