import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {parseConfigRuleValue,schemaForConfigKey} from "@/platform/config/rule-registry";
import {normalizeHouseRules,propertyOnboardingProfileInputSchema} from "@/modules/core/domain/owner-property";
import {guestHubHouseRulesPolicyKey,guestHubHouseRulesPolicySchema,effectiveGuestHubHouseRulesPolicy,GuestHubHouseRulesAccessError} from "@/modules/guest-hub/domain/guest-hub-house-rules-policy";
import {guestHubHouseRulesContentSchema,renderGuestHubHouseRulesContent,renderGuestHubHouseRulesNotice} from "@/modules/guest-hub/domain/guest-hub-house-rules-content";
import {approvedGuestHubHouseRulesSource,canonicalGuestHubHouseRules} from "@/modules/guest-hub/domain/guest-hub-house-rules-source";
import {ownedGuestHubHouseRulesPolicy as policy} from "../integration/support/guest-hub-house-rules-policy";

describe("approved native house rules and original canonical source",()=>{
 it("preserves the original Core input and normalization API without a policy-registry cycle",()=>{
  expect(normalizeHouseRules(" first, first\nsecond ")).toEqual(["first","second"]);expect(propertyOnboardingProfileInputSchema.parse({}).houseRules).toEqual([]);expect(canonicalGuestHubHouseRules(["first","second"])).toEqual(["first","second"]);
 });
 it("registers the closed policy key without inventing an approval or requiring enablement",()=>{
  const disabled=policy({enabled:false,processing_approval_reference:null,wording_approval_reference:null,notice:null,approved_content:null});
  expect(schemaForConfigKey(guestHubHouseRulesPolicyKey)).toBe(guestHubHouseRulesPolicySchema);expect(parseConfigRuleValue(guestHubHouseRulesPolicyKey,disabled)).toEqual(disabled);expect(()=>effectiveGuestHubHouseRulesPolicy(disabled,disabled)).toThrow(GuestHubHouseRulesAccessError);
 });
 it.each(["processing_approval_reference","wording_approval_reference","notice","approved_content"]as const)("requires actual %s before enabling acceptance",key=>{
  expect(guestHubHouseRulesPolicySchema.safeParse({...policy(),[key]:null}).success).toBe(false);
 });
 it("requires the original affirmative acknowledgement statement and rejects ignored fields",()=>{
  expect(guestHubHouseRulesPolicySchema.safeParse({...policy(),require_acknowledgement:false}).success).toBe(false);expect(guestHubHouseRulesPolicySchema.safeParse({...policy(),financialAccess:true}).success).toBe(false);
 });
 it.each(([null,undefined,[],[""],[" leading space"],["trailing space "],[42],Array.from({length:31},()=>"Owned original rule"),["x".repeat(181)]]as unknown[]).map(source_rules=>({source_rules})))("rejects an absent, altered or noncanonical source snapshot %#",({source_rules})=>{
  expect(guestHubHouseRulesPolicySchema.safeParse({...policy(),approved_content:{...policy().approved_content!,source_rules}}).success).toBe(false);expect(()=>canonicalGuestHubHouseRules(source_rules)).toThrow(GuestHubHouseRulesAccessError);
 });
 it("covers every source rule and requires EN and FR wording",()=>{
  const original=policy().approved_content!;for(const rules of[original.rules.slice(1),[...original.rules,original.rules[0]],[{en:"Owned rule"},original.rules[1]],[{fr:"Règle de test"},original.rules[1]]])expect(guestHubHouseRulesPolicySchema.safeParse({...policy(),approved_content:{...original,rules}}).success).toBe(false);
 });
 it("keeps both captured and current admission budgets without changing the approved edition",()=>{
  const original=policy(),current=policy({submissions:{requests:1,window_seconds:7200}}),effective=effectiveGuestHubHouseRulesPolicy(original,current),organizationId=randomUUID(),propertyId=randomUUID();expect(effective.limits).toEqual([original.submissions,current.submissions]);expect(approvedGuestHubHouseRulesSource(effective,organizationId,propertyId,original.approved_content!.source_rules).editionFingerprint).toBe(approvedGuestHubHouseRulesSource(effectiveGuestHubHouseRulesPolicy(original,original),organizationId,propertyId,original.approved_content!.source_rules).editionFingerprint);
 });
 it("closes a captured grant after any source, purpose, wording or acknowledgement change",()=>{
  const original=policy(),content=original.approved_content!;const changes=[{enabled:false},{processing_approval_reference:"Another owned purpose"},{wording_approval_reference:"Another wording approval"},{notice:{...original.notice!,reference:"different_notice"}},{approved_content:{...content,source_rules:[...content.source_rules].reverse()}},{approved_content:{...content,rules:[...content.rules].reverse()}},{approved_content:{...content,title:{...content.title,en:"Another approved title"}}},{approved_content:{...content,acceptanceStatement:{...content.acceptanceStatement,fr:"Autre déclaration"}}}];for(const change of changes)expect(()=>effectiveGuestHubHouseRulesPolicy(original,policy(change))).toThrow(GuestHubHouseRulesAccessError);
 });
 it("binds the original ordered words to the actual organization and property",()=>{
  const approved=policy(),effective=effectiveGuestHubHouseRulesPolicy(approved,approved),organizationId=randomUUID(),propertyId=randomUUID(),rules=approved.approved_content!.source_rules,original=approvedGuestHubHouseRulesSource(effective,organizationId,propertyId,rules);
  expect(original.source.rules).toEqual(rules);expect(approvedGuestHubHouseRulesSource(effective,randomUUID(),propertyId,rules).sourceFingerprint).not.toBe(original.sourceFingerprint);expect(approvedGuestHubHouseRulesSource(effective,organizationId,randomUUID(),rules).editionFingerprint).not.toBe(original.editionFingerprint);for(const changed of[[...rules].reverse(),[rules[0],"Another original rule"]])expect(()=>approvedGuestHubHouseRulesSource(effective,organizationId,propertyId,changed)).toThrow(GuestHubHouseRulesAccessError);
 });
 it("renders and records one complete approved Arabic or fallback edition",()=>{
  const original=policy().approved_content!,content=guestHubHouseRulesContentSchema.parse({title:original.title,rules:original.rules,acceptanceStatement:original.acceptanceStatement}),arabic=renderGuestHubHouseRulesContent(content,"ar");expect(arabic.locale).toBe("ar");expect(arabic.rules).toEqual(content.rules.map(rule=>rule.ar));
  const partial={...content,rules:content.rules.map((rule,index)=>index===0?{en:rule.en,fr:rule.fr}:rule)},fallback=renderGuestHubHouseRulesContent(partial,"ar");expect(fallback).toEqual({requestedLocale:"ar",locale:"en",title:content.title.en,rules:content.rules.map(rule=>rule.en),acceptanceStatement:content.acceptanceStatement.en});expect(renderGuestHubHouseRulesContent(content,"fr").rules).toEqual(content.rules.map(rule=>rule.fr));expect(renderGuestHubHouseRulesContent(content,"en").acceptanceStatement).toBe(content.acceptanceStatement.en);
 });
 it("retains the exact displayed processing notice and rejects an unsupported language",()=>{
  const original=policy(),notice=original.notice!,effective=effectiveGuestHubHouseRulesPolicy(original,original);expect(renderGuestHubHouseRulesNotice(notice,"fr")).toEqual({title:notice.title.fr,paragraphs:notice.paragraphs.map(paragraph=>paragraph.fr)});expect(()=>renderGuestHubHouseRulesContent(effective.approvedContent,"es"as never)).toThrow();
 });
});
