import {randomUUID} from "node:crypto";
import {guestHubIdentityDocumentDelegationBindingSchema} from "@/modules/guest-hub/domain/guest-hub-identity-document-delegation";

export function ownedGuestHubIdentityDocumentDelegation(){
 const organizationId=randomUUID(),createdBy=randomUUID();
 return guestHubIdentityDocumentDelegationBindingSchema.parse({
  protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_DELEGATION_V1",organizationId,grantId:randomUUID(),grantFingerprint:"a".repeat(64),createdBy,
  authorizationCap:{schemaVersion:1,organizationId,userAccountId:createdBy,permissions:["documents:create"],scopes:[{organizationId,scopeType:"property",scopeId:randomUUID()}]},
  archivePolicy:{organizationId,id:randomUUID(),version:1,value:{source:"NATIVE_DOCUMENT_ARCHIVE",types:[{key:"owned_guest_passport",labels:{en:"Owned identity document",fr:"Document d’identité du test",ar:"وثيقة هوية للاختبار"},sources:["RESERVATION"],privacy:["sensitive"],content_types:["image/jpeg"],max_bytes:1024}],encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",upload_admission:{window_seconds:3600,max_requests:100},storage_url_seconds:60}},
  retentionPolicy:{organizationId,id:randomUUID(),version:1,value:{source:"NATIVE_DOCUMENT_VERSIONS",artifact_inheritance:"ORIGINAL_SIGNED_VERSION",archive_tagging:"ALLOW",type_keys:["owned_guest_passport"],change_admission:{window_seconds:3600,max_requests:100},tags:[{key:"owned_identity_hold",labels:{en:"Owned hold",fr:"Conservation du test",ar:"احتفاظ للاختبار"},blocks_disposition:true,policy_references:["Explicit owned retention decision"]}]}}
 });
}
