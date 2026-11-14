import {guestHubIdentityDocumentPolicySchema,type GuestHubIdentityDocumentPolicy} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";

/** Owned-test decisions only. Production collection has no seeded approval or default policy. */
export function ownedGuestHubIdentityDocumentPolicy(changes:Partial<GuestHubIdentityDocumentPolicy>={}){
 return guestHubIdentityDocumentPolicySchema.parse({
  source:"NATIVE_GUEST_IDENTITY_DOCUMENTS",history:"APPEND_ONLY_RESERVATION_IDENTITY_CAPTURES",storage:"EXISTING_ENCRYPTED_DOCUMENT_ARCHIVE",enabled:true,
  processing_approval_reference:"Explicit owned identity processing approval",retention_approval_reference:"Explicit owned identity retention approval",
  notice:{reference:"Owned identity notice revision",title:{en:"Owned identity notice",fr:"Avis d’identité du test",ar:"إشعار هوية للاختبار"},paragraphs:[{en:"Owned private collection purpose",fr:"Finalité privée du test",ar:"غرض جمع خاص للاختبار"}]},
  require_acknowledgement:true,
  document_types:[{kind:"PASSPORT",document_type_key:"owned_guest_passport",allowed_parts:["IDENTITY_PAGE"],required_parts:["IDENTITY_PAGE"],retention_tag_keys:["owned_identity_hold"]}],
  required_document_kinds:[],content_types:["image/jpeg","image/png","application/pdf"],max_document_bytes:4*1024*1024,max_captures:2,
  submissions:{requests:100,window_seconds:3600},uploads:{requests:100,window_seconds:3600},...changes
 });
}
