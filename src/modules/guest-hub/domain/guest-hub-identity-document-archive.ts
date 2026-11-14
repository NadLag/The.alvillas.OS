import {guestHubIdentityDocumentDelegationBindingSchema,type GuestHubIdentityDocumentDelegationBinding} from "./guest-hub-identity-document-delegation";
import {effectiveGuestHubIdentityDocumentPolicy,GuestHubIdentityDocumentAccessError,type GuestHubIdentityDocumentPolicy} from "./guest-hub-identity-document-policy";

type ArchiveSnapshot=GuestHubIdentityDocumentDelegationBinding["archivePolicy"];
type RetentionSnapshot=GuestHubIdentityDocumentDelegationBinding["retentionPolicy"];
/** Pure constraints only: the caller must first authenticate the delegation and intersect current account authority. */
export function effectiveGuestHubIdentityDocumentArchive(captured:GuestHubIdentityDocumentPolicy,current:GuestHubIdentityDocumentPolicy,delegation:GuestHubIdentityDocumentDelegationBinding,archive:ArchiveSnapshot,retention:RetentionSnapshot){
 const held=guestHubIdentityDocumentDelegationBindingSchema.safeParse(delegation);if(!held.success)throw new GuestHubIdentityDocumentAccessError();
 return intersectGuestHubIdentityDocumentArchivePolicies(captured,current,held.data.archivePolicy,held.data.retentionPolicy,archive,retention);
}
/** Shared pure constraints for an actual staff delegation review and a subsequently authenticated grant. */
export function intersectGuestHubIdentityDocumentArchivePolicies(captured:GuestHubIdentityDocumentPolicy,current:GuestHubIdentityDocumentPolicy,capturedArchive:ArchiveSnapshot,capturedRetention:RetentionSnapshot,archive:ArchiveSnapshot,retention:RetentionSnapshot){
 const originalArchive=guestHubIdentityDocumentDelegationBindingSchema.shape.archivePolicy.safeParse(capturedArchive),originalRetention=guestHubIdentityDocumentDelegationBindingSchema.shape.retentionPolicy.safeParse(capturedRetention),currentArchive=guestHubIdentityDocumentDelegationBindingSchema.shape.archivePolicy.safeParse(archive),currentRetention=guestHubIdentityDocumentDelegationBindingSchema.shape.retentionPolicy.safeParse(retention);
 if(!originalArchive.success||!originalRetention.success||!currentArchive.success||!currentRetention.success||[originalRetention.data.organizationId,currentArchive.data.organizationId,currentRetention.data.organizationId].some(id=>id!==originalArchive.data.organizationId))throw new GuestHubIdentityDocumentAccessError();
 const identity=effectiveGuestHubIdentityDocumentPolicy(captured,current),original={archivePolicy:originalArchive.data,retentionPolicy:originalRetention.data},latestArchive=currentArchive.data.value,latestRetention=currentRetention.data.value;
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
