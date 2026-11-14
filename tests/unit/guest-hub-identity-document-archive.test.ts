import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {effectiveGuestHubIdentityDocumentArchive} from "@/modules/guest-hub/domain/guest-hub-identity-document-archive";
import {GuestHubIdentityDocumentAccessError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentPolicy as policy} from "../integration/support/guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentDelegation as delegation} from "../integration/support/guest-hub-identity-document-delegation";

describe("native identity and canonical archive policy intersection",()=>{
 it("retains actual native reservation, sensitive-document and retention constraints",()=>{
  const held=delegation(),effective=effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,held.archivePolicy,held.retentionPolicy),document=effective.documents[0];expect(document.kind).toBe("PASSPORT");expect(document.documentTypeKey).toBe("owned_guest_passport");expect(document.contentTypes).toEqual(["image/jpeg"]);expect(document.maxBytes).toBe(1024);expect(document.privacy).toEqual(["sensitive"]);expect(document.retentionTags).toEqual(held.retentionPolicy.value.tags);
 });
 it("cannot inherit wider current archive content or byte limits and still applies tighter current limits",()=>{
  const held=delegation(),widened={...held.archivePolicy,value:{...held.archivePolicy.value,types:held.archivePolicy.value.types.map(type=>({...type,max_bytes:2048,content_types:[...type.content_types,"image/png" as const]}))}},narrowed={...held.archivePolicy,value:{...held.archivePolicy.value,types:held.archivePolicy.value.types.map(type=>({...type,max_bytes:128}))}};
  expect(effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,widened,held.retentionPolicy).documents[0]).toMatchObject({maxBytes:1024,contentTypes:["image/jpeg"]});expect(effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,narrowed,held.retentionPolicy).documents[0].maxBytes).toBe(128);expect(effectiveGuestHubIdentityDocumentArchive(policy(),policy({max_document_bytes:64}),held,held.archivePolicy,held.retentionPolicy).documents[0].maxBytes).toBe(64);
 });
 it("closes missing source types, removed sensitive protection, financial classification and withdrawn content types",()=>{
  const held=delegation();for(const changed of[{key:"another_document_type"},{sources:["GUEST"] as const},{privacy:["operational"] as const},{privacy:["sensitive","financial"] as const},{content_types:["application/pdf"] as const}]){const current={...held.archivePolicy,value:{...held.archivePolicy.value,types:held.archivePolicy.value.types.map(type=>({...type,...changed}))}};expect(()=>effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,current as typeof held.archivePolicy,held.retentionPolicy)).toThrow(GuestHubIdentityDocumentAccessError);}
 });
 it("requires the original allowed retention type, actual tag and unchanged retained legal context",()=>{
  const held=delegation();for(const value of[{...held.retentionPolicy.value,archive_tagging:"DENY" as const},{...held.retentionPolicy.value,type_keys:["another_document_type"]},{...held.retentionPolicy.value,tags:held.retentionPolicy.value.tags.map(tag=>({...tag,key:"another_hold"}))},{...held.retentionPolicy.value,tags:held.retentionPolicy.value.tags.map(tag=>({...tag,blocks_disposition:false}))},{...held.retentionPolicy.value,tags:held.retentionPolicy.value.tags.map(tag=>({...tag,policy_references:["Different retention context"]}))}])expect(()=>effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,held.archivePolicy,{...held.retentionPolicy,value})).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("rejects another tenant's current archive or retention rule even when its values are identical",()=>{
  const held=delegation();expect(()=>effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,{...held.archivePolicy,organizationId:randomUUID()},held.retentionPolicy)).toThrow(GuestHubIdentityDocumentAccessError);expect(()=>effectiveGuestHubIdentityDocumentArchive(policy(),policy(),held,held.archivePolicy,{...held.retentionPolicy,organizationId:randomUUID()})).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("masks an optional unavailable kind but never bypasses a captured required kind",()=>{
  const held=delegation(),passport=policy().document_types[0],identity=policy({document_types:[passport,{...passport,kind:"NATIONAL_ID",document_type_key:"owned_guest_id"}]});expect(effectiveGuestHubIdentityDocumentArchive(identity,identity,held,held.archivePolicy,held.retentionPolicy).documents.map(document=>document.kind)).toEqual(["PASSPORT"]);expect(()=>effectiveGuestHubIdentityDocumentArchive({...identity,required_document_kinds:["NATIONAL_ID"]},identity,held,held.archivePolicy,held.retentionPolicy)).toThrow(GuestHubIdentityDocumentAccessError);
 });
});
