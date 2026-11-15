import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {createGuestHubPrivateFormCodec} from "./guest-hub-form-private";
import {guestHubHouseRulesReviewBindingSchema,guestHubHouseRulesReviewTokenSchema,guestHubHouseRulesPayloadBindingSchema,guestHubPrivateHouseRulesSchema,type GuestHubHouseRulesPayloadBinding,type GuestHubPrivateHouseRules} from "./guest-hub-house-rules-contract";
import {GuestHubHouseRulesConfigurationError,GuestHubHouseRulesConflictError} from "./guest-hub-house-rules-policy";

export function guestHubHouseRulesRenderedFingerprint(content:unknown,notice:unknown){return jsonbFingerprint({content,notice});}
export function guestHubStoredHouseRulesReview(binding:GuestHubHouseRulesPayloadBinding,payload:GuestHubPrivateHouseRules){
 const renderedFingerprint=guestHubHouseRulesRenderedFingerprint(payload.content,payload.notice);
 if(renderedFingerprint!==binding.renderedFingerprint||payload.content.requestedLocale!==binding.requestedLocale||payload.content.locale!==binding.displayedLocale)throw new GuestHubHouseRulesConfigurationError();
 return guestHubHouseRulesReviewBindingSchema.parse({protocol:"NATIVE_GUEST_HOUSE_RULES_REVIEW_V1",organizationId:binding.organizationId,linkId:binding.linkId,reservationId:binding.reservationId,propertyId:binding.propertyId,guestId:binding.guestId,grantId:binding.grantId,grantFingerprint:binding.grantFingerprint,policyFingerprint:binding.policyFingerprint,sourceFingerprint:binding.sourceFingerprint,previousAcceptanceId:binding.previousId,idempotencyKey:binding.commandKey,locale:binding.requestedLocale,acknowledged:payload.acknowledged,rulesFingerprint:binding.rulesFingerprint,editionFingerprint:binding.editionFingerprint,renderedFingerprint});
}
const codec=createGuestHubPrivateFormCodec({reviewSchema:guestHubHouseRulesReviewBindingSchema,reviewTokenSchema:guestHubHouseRulesReviewTokenSchema,bindingSchema:guestHubHouseRulesPayloadBindingSchema,payloadSchema:guestHubPrivateHouseRulesSchema,storedReview:guestHubStoredHouseRulesReview,tokenPrefix:"guest-house-rules-review-v1",reviewPurpose:"alvillas.guest-hub.house-rules-review.v1",commandPurpose:"alvillas.guest-hub.house-rules-command.v1",payloadPurpose:"alvillas.guest-hub.house-rules-payload.v1",ConfigurationError:GuestHubHouseRulesConfigurationError,ConflictError:GuestHubHouseRulesConflictError});
export const {signReview:signGuestHubHouseRulesReview,verifyReview:verifyGuestHubHouseRulesReview,signCommand:signGuestHubHouseRulesCommand,verifyCommand:verifyGuestHubHouseRulesCommand}=codec;
export const guestHubHouseRulesMaximumPayloadBytes=65536;
export function encryptGuestHubHouseRules(raw:unknown,binding:GuestHubHouseRulesPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 const bytes=codec.encrypt(raw,binding,env);if(bytes.byteLength<64||bytes.byteLength>guestHubHouseRulesMaximumPayloadBytes){bytes.fill(0);throw new GuestHubHouseRulesConfigurationError();}return bytes;
}
export function decryptGuestHubHouseRules(ciphertext:Uint8Array,binding:GuestHubHouseRulesPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 if(ciphertext.byteLength<64||ciphertext.byteLength>guestHubHouseRulesMaximumPayloadBytes)throw new GuestHubHouseRulesConfigurationError();return codec.decrypt(ciphertext,binding,env);
}
