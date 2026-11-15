import {propertyHouseRulesSchema} from "@/platform/config/property-house-rules";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubIdSchema} from "./guest-hub-contract";
import {GuestHubHouseRulesAccessError} from "./guest-hub-house-rules-policy";
import type {effectiveGuestHubHouseRulesPolicy} from "./guest-hub-house-rules-policy";

export function canonicalGuestHubHouseRules(raw:unknown){
 const parsed=propertyHouseRulesSchema.safeParse(raw);
 if(!parsed.success||!parsed.data.length||JSON.stringify(parsed.data)!==JSON.stringify(raw))throw new GuestHubHouseRulesAccessError();
 return parsed.data;
}
export function guestHubHouseRulesSourceSnapshot(organizationId:string,propertyId:string,raw:unknown){
 return{protocol:"NATIVE_PROPERTY_HOUSE_RULES_SOURCE_V1" as const,organizationId:guestHubIdSchema.parse(organizationId),propertyId:guestHubIdSchema.parse(propertyId),rules:canonicalGuestHubHouseRules(raw)};
}
export function approvedGuestHubHouseRulesSource(policy:ReturnType<typeof effectiveGuestHubHouseRulesPolicy>,organizationId:string,propertyId:string,raw:unknown){
 const source=guestHubHouseRulesSourceSnapshot(organizationId,propertyId,raw);
 if(JSON.stringify(source.rules)!==JSON.stringify(policy.approvedSourceRules))throw new GuestHubHouseRulesAccessError();
 const sourceFingerprint=jsonbFingerprint(source),editionFingerprint=jsonbFingerprint({protocol:"NATIVE_APPROVED_HOUSE_RULES_EDITION_V1",sourceFingerprint,processingApprovalReference:policy.processingApprovalReference,wordingApprovalReference:policy.wordingApprovalReference,notice:policy.notice,content:policy.approvedContent});
 return{source,sourceFingerprint,editionFingerprint};
}
