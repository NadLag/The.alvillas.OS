import {describe,it,expect} from "vitest";
import {documentUploadReviewInput} from "@/modules/documents/domain/document-command";
import {parseConfigRuleValue,schemaForConfigKey} from "@/platform/config/rule-registry";
import {guestHubIdentityDocumentPolicyKey,guestHubIdentityDocumentPolicySchema,effectiveGuestHubIdentityDocumentPolicy,GuestHubIdentityDocumentAccessError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentPolicy as policy} from "../integration/support/guest-hub-identity-document-policy";

const nationalId={kind:"NATIONAL_ID" as const,document_type_key:"owned_guest_national_id",allowed_parts:["FRONT","BACK"] as Array<"FRONT"|"BACK">,required_parts:["FRONT"] as Array<"FRONT"|"BACK">,retention_tag_keys:["owned_identity_hold"]};
describe("explicit private identity collection policy",()=>{
 it("uses the canonical configuration registry without a default approval or an unrecognized policy path",()=>{
  const approved=policy();expect(schemaForConfigKey(guestHubIdentityDocumentPolicyKey)).toBe(guestHubIdentityDocumentPolicySchema);expect(parseConfigRuleValue(guestHubIdentityDocumentPolicyKey,approved)).toEqual(approved);expect(()=>parseConfigRuleValue(guestHubIdentityDocumentPolicyKey,{...approved,retention_approval_reference:null})).toThrow();
 });
 it("requires actual processing, retention, notice and type decisions before enabling collection",()=>{
  for(const changes of[{processing_approval_reference:null},{retention_approval_reference:null},{notice:null},{document_types:[]}]){expect(guestHubIdentityDocumentPolicySchema.safeParse({...policy(),...changes}).success).toBe(false);expect(guestHubIdentityDocumentPolicySchema.safeParse({...policy(),...changes,enabled:false}).success).toBe(true);}
  expect(()=>effectiveGuestHubIdentityDocumentPolicy(policy(),policy({enabled:false}))).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("rejects duplicate kinds, unapproved required kinds, duplicate sides and unapproved required sides",()=>{
  const type=policy().document_types[0];
  for(const changes of[{document_types:[type,type]},{required_document_kinds:["NATIONAL_ID"]},{document_types:[{...type,allowed_parts:["IDENTITY_PAGE","IDENTITY_PAGE"]}]},{document_types:[{...type,required_parts:["BACK"]}]}])expect(guestHubIdentityDocumentPolicySchema.safeParse({...policy(),...changes}).success).toBe(false);
 });
 it("retains captured kinds, sides, content types, size and capture limits when a current rule widens them",()=>{
  const captured=policy({content_types:["image/jpeg"],max_document_bytes:1000,max_captures:1}),current=policy({document_types:[...captured.document_types,nationalId],max_document_bytes:2000,max_captures:5,require_acknowledgement:false}),effective=effectiveGuestHubIdentityDocumentPolicy(captured,current);
  expect(effective.documents).toEqual([{kind:"PASSPORT",documentTypeKey:"owned_guest_passport",allowedParts:["IDENTITY_PAGE"],requiredParts:["IDENTITY_PAGE"],retentionTagKeys:["owned_identity_hold"]}]);expect(effective.contentTypes).toEqual(["image/jpeg"]);expect(effective.maxDocumentBytes).toBe(1000);expect(effective.maxCaptures).toBe(1);expect(effective.requireAcknowledgement).toBe(true);
 });
 it("enforces the stricter current limits and preserves both independently configured admission windows",()=>{
  const captured=policy(),current=policy({content_types:["image/png"],max_document_bytes:900,max_captures:1,submissions:{requests:3,window_seconds:7},uploads:{requests:5,window_seconds:11}}),effective=effectiveGuestHubIdentityDocumentPolicy(captured,current);
  expect(effective.contentTypes).toEqual(["image/png"]);expect(effective.maxDocumentBytes).toBe(900);expect(effective.maxCaptures).toBe(1);expect(effective.limits).toEqual([captured.submissions,current.submissions]);expect(effective.uploadLimits).toEqual([captured.uploads,current.uploads]);
 });
 it("combines required sides without acquiring a side the original grant never allowed",()=>{
  const original=policy({document_types:[nationalId]}),latest=policy({document_types:[{...nationalId,required_parts:["BACK"]}]}),effective=effectiveGuestHubIdentityDocumentPolicy(original,latest);
  expect(effective.documents[0].requiredParts).toEqual(["FRONT","BACK"]);expect(()=>effectiveGuestHubIdentityDocumentPolicy(original,policy({document_types:[{...nationalId,allowed_parts:["BACK"],required_parts:["BACK"]}]}))).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("withdraws optional kinds while closing grants whose original or current required kind is unavailable",()=>{
  const captured=policy({document_types:[...policy().document_types,nationalId]}),latest=policy({document_types:[nationalId]});expect(effectiveGuestHubIdentityDocumentPolicy(captured,latest).documents.map(type=>type.kind)).toEqual(["NATIONAL_ID"]);
  expect(()=>effectiveGuestHubIdentityDocumentPolicy({...captured,required_document_kinds:["PASSPORT"]},latest)).toThrow(GuestHubIdentityDocumentAccessError);expect(()=>effectiveGuestHubIdentityDocumentPolicy(policy(),policy({document_types:[...policy().document_types,nationalId],required_document_kinds:["NATIONAL_ID"]}))).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("requires a fresh grant for a changed processing purpose, notice, retention decision, type mapping or retention tags",()=>{
  const original=policy(),type=original.document_types[0];for(const current of[policy({processing_approval_reference:"Different explicit processing decision"}),policy({notice:{...original.notice!,reference:"Different notice revision"}}),policy({retention_approval_reference:"Different explicit retention decision"}),policy({document_types:[{...type,document_type_key:"another_native_document_type"}]}),policy({document_types:[{...type,retention_tag_keys:["different_hold"]}]})])expect(()=>effectiveGuestHubIdentityDocumentPolicy(original,current)).toThrow(GuestHubIdentityDocumentAccessError);
 });
 it("retains an identical approved tag set independently of order and never weakens acknowledgement",()=>{
  const type={...policy().document_types[0],retention_tag_keys:["owned_hold_a","owned_hold_b"]},captured=policy({document_types:[type],require_acknowledgement:false}),current=policy({document_types:[{...type,retention_tag_keys:[...type.retention_tag_keys].reverse()}]});expect(effectiveGuestHubIdentityDocumentPolicy(captured,current).documents[0].retentionTagKeys).toEqual(["owned_hold_a","owned_hold_b"]);expect(effectiveGuestHubIdentityDocumentPolicy(captured,current).requireAcknowledgement).toBe(true);
 });
 it("shares canonical archive byte bounds and rejects zero or fractional budgets, unsupported content and extra collection fields",()=>{
  for(const max_document_bytes of[0,-1,0.5,10*1024*1024+1]){expect(documentUploadReviewInput.shape.fileSize.safeParse(max_document_bytes).success).toBe(false);expect(guestHubIdentityDocumentPolicySchema.safeParse({...policy(),max_document_bytes}).success).toBe(false);}expect(policy({max_document_bytes:10*1024*1024}).max_document_bytes).toBe(10*1024*1024);
  for(const changes of[{max_captures:0},{max_captures:1.5},{submissions:{requests:0,window_seconds:3600}},{uploads:{requests:1,window_seconds:0}},{content_types:["text/html"]},{passport_number:"unapproved collection field"},{storage:"PUBLIC_OBJECT_URL"}])expect(guestHubIdentityDocumentPolicySchema.safeParse({...policy(),...changes}).success).toBe(false);
 });
});
