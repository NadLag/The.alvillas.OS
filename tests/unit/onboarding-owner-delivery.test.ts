import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {renderOnboardingOwnerPackageEmails} from "@/platform/email/onboarding-owner-package";
import {onboardingOwnerDeliverySourceSchema,onboardingOwnerDeliveryCommandSchema,onboardingOwnerDeliveryProtocol,onboardingOwnerDeliveryReceiptSchema} from "@/modules/onboarding/domain/onboarding-owner-delivery";
import {onboardingOwnerDeliveryPolicySchema} from "@/modules/onboarding/domain/onboarding-owner-delivery-policy";

function source(){return{protocol:onboardingOwnerDeliveryProtocol,organizationId:randomUUID(),packageId:randomUUID(),sessionId:randomUUID(),reviewRevisionId:randomUUID(),ownerId:randomUUID(),propertyId:randomUUID(),nativePackageFingerprint:"a".repeat(64),ownerName:"Actual <Owner> & recipient",ownerEmail:"owner@example.test",ownerLocale:"fr"as const,propertyName:"Actual Villa $' <Garden>",policy:{source:"NATIVE_COMPLETED_OWNER_PACKAGE"as const,channel:"EMAIL"as const,template:"NATIVE_OWNER_PACKAGE_EMAIL_V1"as const,locales:["en","fr"]as Array<"en"|"fr"|"ar">},documents:(["en","fr"]as const).map(locale=>({locale,instanceId:randomUUID(),documentId:randomUUID(),versionId:randomUUID()}))};}

describe("original bilingual owner package emails",()=>{
 it("does not treat an admitted email intent as provider acceptance or verified delivery",()=>{const value={recorded:true,id:randomUUID(),packageId:randomUUID(),idempotencyKey:randomUUID(),requestedAt:"2026-11-12T12:00:00.000Z",locale:"fr",deliveryRecordId:null,state:"PENDING",acceptedAt:null,deliveredAt:null,replayed:false};expect(onboardingOwnerDeliveryReceiptSchema.safeParse(value).success).toBe(true);expect(onboardingOwnerDeliveryReceiptSchema.safeParse({...value,state:"DELIVERED"}).success).toBe(false);});
 it("keeps provider acceptance distinct from an actual verified delivery timestamp",()=>{const value={recorded:true,id:randomUUID(),packageId:randomUUID(),idempotencyKey:randomUUID(),requestedAt:"2026-11-12T12:00:00.000Z",locale:"fr",deliveryRecordId:randomUUID(),state:"ACCEPTED",acceptedAt:"2026-11-12T12:01:00.000Z",deliveredAt:null,replayed:true};expect(onboardingOwnerDeliveryReceiptSchema.safeParse(value).success).toBe(true);expect(onboardingOwnerDeliveryReceiptSchema.safeParse({...value,state:"DELIVERED"}).success).toBe(false);expect(onboardingOwnerDeliveryReceiptSchema.safeParse({...value,state:"DELIVERED",deliveredAt:"2026-11-12T12:02:00.000Z"}).success).toBe(true);});
 it("generates both originals and selects only the owner's real communication language",()=>{
  const data=source(),result=renderOnboardingOwnerPackageEmails(data);expect(result.variants.map(row=>row.locale)).toEqual(["en","fr"]);expect(result.selected.locale).toBe("fr");
  for(const mail of result.variants){expect(mail.to).toBe(data.ownerEmail);expect(mail.subject).toContain(data.propertyName);expect(mail.text).toContain(data.ownerName);expect(mail.html).toContain("Actual &lt;Owner&gt; &amp; recipient");expect(mail.html).not.toContain("<Owner>");expect(mail.template).toBe("onboarding.owner_package");expect(mail).not.toHaveProperty("attachments");}
  expect(result.fingerprint).toBe(renderOnboardingOwnerPackageEmails(data).fingerprint);
 });
 it("retains literal replacement metacharacters and escapes original property names in HTML",()=>{const data=source(),mail=renderOnboardingOwnerPackageEmails(data).variants[0];expect(mail.subject).toContain("$' <Garden>");expect(mail.html).toContain("&lt;Garden&gt;");});
 it("uses a single subject line without truncating the original configuration name",()=>{const data=source();data.propertyName="Actual\r\nProperty\u2028Name";const mail=renderOnboardingOwnerPackageEmails(data).selected;expect(mail.subject).toContain("Actual Property Name");expect(mail.subject).not.toMatch(/[\r\n\u2028\u2029]/u);});
 it("binds corrected recipient, configured language and native configuration into the original fingerprint",()=>{
  const data=source(),original=renderOnboardingOwnerPackageEmails(data).fingerprint;
  for(const corrected of[{...data,ownerEmail:"corrected@example.test"},{...data,ownerLocale:"en"},{...data,nativePackageFingerprint:"b".repeat(64)}])expect(renderOnboardingOwnerPackageEmails(corrected).fingerprint).not.toBe(original);
 });
 it("requires explicit Arabic policy and an actual distinct Arabic original before selecting RTL",()=>{
  const data=source(),arabic={...data,ownerLocale:"ar",policy:{...data.policy,locales:["en","fr","ar"]},documents:[...data.documents,{locale:"ar",instanceId:randomUUID(),documentId:randomUUID(),versionId:randomUUID()}]},result=renderOnboardingOwnerPackageEmails(arabic);
  expect(result.selected.locale).toBe("ar");expect(result.selected.html).toContain('lang="ar" dir="rtl"');expect(result.selected.subject).toMatch(/[\u0600-\u06ff]/u);expect(result.variants.map(row=>row.locale)).toEqual(["en","fr","ar"]);
 });
 it.each(["OWNER_AR_ONLY","POLICY_AR_ONLY","DOCUMENT_AR_ONLY"]as const)("rejects %s without inventing a language fallback",mode=>{
  const data=source();const extra={locale:"ar",instanceId:randomUUID(),documentId:randomUUID(),versionId:randomUUID()};
  const changed=mode==="OWNER_AR_ONLY"?{...data,ownerLocale:"ar"}:mode==="POLICY_AR_ONLY"?{...data,policy:{...data.policy,locales:["en","fr","ar"]}}:{...data,documents:[...data.documents,extra]};
  expect(()=>renderOnboardingOwnerPackageEmails(changed)).toThrow();
 });
 it.each(["locale","instanceId","documentId","versionId"]as const)("rejects duplicated actual document %s",key=>{const data=source();data.documents[1]={...data.documents[1],[key]:data.documents[0][key]};expect(onboardingOwnerDeliverySourceSchema.safeParse(data).success).toBe(false);});
 it("rejects a missing French original and an uncompleted version",()=>{const data=source();expect(onboardingOwnerDeliverySourceSchema.safeParse({...data,documents:data.documents.slice(0,1)}).success).toBe(false);expect(onboardingOwnerDeliverySourceSchema.safeParse({...data,documents:[data.documents[0],{...data.documents[1],versionId:null}]}).success).toBe(false);});
 it.each(["to","locale","ownerId","documents","attachments","delivered"])("rejects caller-supplied %s on the public reference command",key=>{expect(onboardingOwnerDeliveryCommandSchema.safeParse({packageId:randomUUID(),idempotencyKey:randomUUID(),reviewFingerprint:"a".repeat(64),reason:"Actual original delivery command",[key]:true}).success).toBe(false);});
 it.each([["en"],["fr"],["en","en"],["fr","ar"]])("requires both approved email languages in %j",(...locales)=>{expect(onboardingOwnerDeliveryPolicySchema.safeParse({source:"NATIVE_COMPLETED_OWNER_PACKAGE",channel:"EMAIL",template:"NATIVE_OWNER_PACKAGE_EMAIL_V1",locales}).success).toBe(false);});
});
