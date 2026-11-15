import {createGuestHubPrivateFormCodec} from "./guest-hub-form-private";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubIdentityDocumentReviewTokenSchema,guestHubIdentityDocumentMaximumJsonBytes} from "./guest-hub-identity-document-contract";
import {guestHubIdentityDocumentReviewBindingSchema,guestHubIdentityDocumentPayloadBindingSchema,guestHubIdentityDocumentManifestSchema,guestHubPrivateIdentityDocumentSchema,guestHubStoredIdentityDocumentReview,type GuestHubIdentityDocumentPayloadBinding,type GuestHubPrivateIdentityDocument} from "./guest-hub-identity-document-private-contract";
import {GuestHubIdentityDocumentConfigurationError,GuestHubIdentityDocumentConflictError} from "./guest-hub-identity-document-policy";

const codec=createGuestHubPrivateFormCodec({
 reviewSchema:guestHubIdentityDocumentReviewBindingSchema,reviewTokenSchema:guestHubIdentityDocumentReviewTokenSchema,
 bindingSchema:guestHubIdentityDocumentPayloadBindingSchema,payloadSchema:guestHubPrivateIdentityDocumentSchema,
 tokenPrefix:"guest-identity-documents-review-v1",reviewPurpose:"alvillas.guest-hub.identity-document-review.v1",
 commandPurpose:"alvillas.guest-hub.identity-document-command.v1",payloadPurpose:"alvillas.guest-hub.identity-document-payload.v1",
 storedReview:guestHubStoredIdentityDocumentReview,ConfigurationError:GuestHubIdentityDocumentConfigurationError,ConflictError:GuestHubIdentityDocumentConflictError
});
export const {
 signReview:signGuestHubIdentityDocumentReview,verifyReview:verifyGuestHubIdentityDocumentReview,
 signCommand:signGuestHubIdentityDocumentCommand,verifyCommand:verifyGuestHubIdentityDocumentCommand
}=codec;
function requireManifest(raw:unknown,binding:GuestHubIdentityDocumentPayloadBinding,payload?:GuestHubPrivateIdentityDocument){
 const manifest=guestHubIdentityDocumentManifestSchema.parse(raw);
 if(jsonbFingerprint(manifest)!==binding.manifestFingerprint||payload&&(manifest.length!==payload.files.length||manifest.some(item=>!payload.files.some(file=>file.kind===item.kind&&file.part===item.part))))throw new GuestHubIdentityDocumentConfigurationError();
 return manifest;
}
export function encryptGuestHubIdentityDocumentCapture(raw:unknown,rawBinding:unknown,manifest:unknown,env:NodeJS.ProcessEnv=process.env){
 try{const binding=guestHubIdentityDocumentPayloadBindingSchema.parse(rawBinding),payload=guestHubPrivateIdentityDocumentSchema.parse(raw);requireManifest(manifest,binding,payload);return codec.encrypt(payload,binding,env);}catch{throw new GuestHubIdentityDocumentConfigurationError();}
}
export function decryptGuestHubIdentityDocumentCapture(ciphertext:Uint8Array,rawBinding:unknown,manifest:unknown,env:NodeJS.ProcessEnv=process.env){
 try{if(ciphertext.byteLength<64||ciphertext.byteLength>guestHubIdentityDocumentMaximumJsonBytes*2)throw new GuestHubIdentityDocumentConfigurationError();const binding=guestHubIdentityDocumentPayloadBindingSchema.parse(rawBinding);requireManifest(manifest,binding);const payload=codec.decrypt(ciphertext,binding,env);requireManifest(manifest,binding,payload);return payload;}catch{throw new GuestHubIdentityDocumentConfigurationError();}
}
