import {createHash} from "node:crypto";
import type {GuestHubIdentityDocumentCapture} from "@prisma/client";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubIdentityDocumentManifestSchema,guestHubIdentityDocumentPayloadBindingSchema} from "../domain/guest-hub-identity-document-private-contract";
import {GuestHubIdentityDocumentConfigurationError} from "../domain/guest-hub-identity-document-policy";

export function guestHubIdentityCaptureBinding(row:GuestHubIdentityDocumentCapture){
 const manifest=guestHubIdentityDocumentManifestSchema.parse(row.fileManifest);
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint||jsonbFingerprint(manifest)!==row.manifestFingerprint||createHash("sha256").update(row.encryptedPayload).digest("hex")!==row.payloadSha256)throw new GuestHubIdentityDocumentConfigurationError();
 return guestHubIdentityDocumentPayloadBindingSchema.parse({
  protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_CAPTURE_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,grantId:row.grantId,
  reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,
  commandKey:row.commandKey,commandHash:row.commandHash,commandKeyVersion:row.commandKeyVersion,
  grantFingerprint:row.grantFingerprint,formFingerprint:row.formFingerprint,manifestFingerprint:row.manifestFingerprint,
  policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,createdAt:row.createdAt.toISOString()
 });
}
