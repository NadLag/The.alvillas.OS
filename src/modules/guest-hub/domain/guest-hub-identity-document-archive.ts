import {guestHubIdentityDocumentDelegationBindingSchema,type GuestHubIdentityDocumentDelegationBinding} from "./guest-hub-identity-document-delegation";
import {effectiveGuestHubIdentityDocumentPolicy,GuestHubIdentityDocumentAccessError,type GuestHubIdentityDocumentPolicy} from "./guest-hub-identity-document-policy";

type ArchiveSnapshot=GuestHubIdentityDocumentDelegationBinding["archivePolicy"];
type RetentionSnapshot=GuestHubIdentityDocumentDelegationBinding["retentionPolicy"];
/** Pure constraints only: the caller must first authenticate the delegation and intersect current account authority. */
export function effectiveGuestHubIdentityDocumentArchive(captured:GuestHubIdentityDocumentPolicy,current:GuestHubIdentityDocumentPolicy,delegation:GuestHubIdentityDocumentDelegationBinding,archive:ArchiveSnapshot,retention:RetentionSnapshot){
 const held=guestHubIdentityDocumentDelegationBindingSchema.safeParse(delegation),currentArchive=guestHubIdentityDocumentDelegationBindingSchema.shape.archivePolicy.safeParse(archive),currentRetention=guestHubIdentityDocumentDelegationBindingSchema.shape.retentionPolicy.safeParse(retention);
 if(!held.success||!currentArchive.success||!currentRetention.success||currentArchive.data.organizationId!==held.data.organizationId||currentRetention.data.organizationId!==held.data.organizationId)throw new GuestHubIdentityDocumentAccessError();
 const identity=effectiveGuestHubIdentityDocumentPolicy(captured,current),original=held.data,latestArchive=currentArchive.data.value,latestRetention=currentRetention.data.value;
 if(original.retentionPolicy.value.archive_tagging!=="ALLOW"||latestRetention.archive_tagging!=="ALLOW")throw new GuestHubIdentityDocumentAccessError();
 const documents=identity.documents.flatMap(document=>{
  const capturedType=original.archivePolicy.value.types.find(type=>type.key===document.documentTypeKey),currentType=latestArchive.types.find(type=>type.key===document.documentTypeKey);
  if(!capturedType||!currentType||![capturedType,currentType].every(type=>type.sources.includes("RESERVATION")&&type.privacy.includes("sensitive")&&!type.privacy.includes("financial")))return[];
  if(!original.retentionPolicy.value.type_keys.includes(document.documentTypeKey)||!latestRetention.type_keys.includes(document.documentTypeKey))return[];
  const contentTypes=identity.contentTypes.filter(type=>capturedType.content_types.includes(type)&&currentType.content_types.includes(type));if(!contentTypes.length)return[];
  const retentionTags=[];for(const key of document.retentionTagKeys){const capturedTag=original.retentionPolicy.value.tags.find(tag=>tag.key===key),currentTag=latestRetention.tags.find(tag=>tag.key===key);if(!capturedTag||!currentTag||JSON.stringify(capturedTag)!==JSON.stringify(currentTag))return[];retentionTags.push(capturedTag);}
  return[{...document,contentTypes,maxBytes:Math.min(identity.maxDocumentBytes,capturedType.max_bytes,currentType.max_bytes),privacy:[...new Set([...capturedType.privacy,...currentType.privacy])].sort(),retentionTags}];
 });
 if(!documents.length||identity.requiredKinds.some(kind=>!documents.some(document=>document.kind===kind)))throw new GuestHubIdentityDocumentAccessError();
 return{...identity,documents};
}
