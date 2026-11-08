import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeLeadDocumentSource,nativeLeadDocumentBindings} from "@/platform/documents/lead-source";
import {nativeLeadFixture,nativeLeadInput,nativeLeadProfileFixture,nativeLeadFinancialGuard} from "./support/lead-fixture";
import {captureLead} from "@/modules/crm/application/lead-capture-service";
import {provisionIntegrationRole} from "./support/database-role";
import {reviewLeadProfile,admitLeadProfile} from "@/modules/crm/application/lead-profile-service";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[],env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"proposal-native:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{const url=process.env.TEST_DATABASE_URL,target=url?new URL(url):null;if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_crm_proposal")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned native proposal database required");admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financial=await nativeLeadFinancialGuard(admin,db);});
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(){const f=await nativeLeadProfileFixture(admin,db,env);organizations.push(f.organizationId);return f;}

describe("native acquisition document source composition",()=>{
 it("requires an actual approved Arabic catalog label while preserving the mandatory EN/FR contract",async()=>{
  const f=await nativeLeadFixture(admin,db,{property_types:[{key:"villa",label:{en:"Approved villa",fr:"Villa approuvée"}}]});organizations.push(f.organizationId);const input=nativeLeadInput(),lead=await captureLead(f.ctx,input,{db,env});
  for(const locale of["en","fr"] as const){const result=await withTenant(db,f.organizationId,tx=>nativeLeadDocumentBindings(tx,f.organizationId,lead.id,["lead_property_type"],locale,env));expect(result.bindings.get("lead_property_type")).toMatchObject({value:f.policy.property_types[0].label[locale],privacy:["sensitive"]});}
  await expect(withTenant(db,f.organizationId,tx=>nativeLeadDocumentBindings(tx,f.organizationId,lead.id,["lead_property_type"],"ar",env))).rejects.toThrow("document_template_binding_unavailable");
 });
 it("binds native positions without putting contact data or private payloads into source metadata",async()=>{
  const f=await fixture(),source=await withTenant(db,f.organizationId,tx=>nativeLeadDocumentSource(tx,f.organizationId,f.lead.id));
  expect(source).toMatchObject({resource:{type:"lead",id:f.lead.id,organizationId:f.organizationId,dataClass:"personal",status:"NEW",assignedUserAccountId:null},snapshot:{leadId:f.lead.id,profileRevisionId:null,stageRevisionId:null,assignmentRevisionId:null,capturePolicyId:f.rule.id},label:f.lead.id,archived:false});
  for(const value of[f.input.fields.ownerContact,f.input.fields.email,f.input.fields.notes])expect(JSON.stringify(source?.snapshot)).not.toContain(value);
 });
 it.each(["en","fr","ar"] as const)("renders only the actual approved native catalog labels in %s",async locale=>{
  const f=await fixture(),result=await withTenant(db,f.organizationId,tx=>nativeLeadDocumentBindings(tx,f.organizationId,f.lead.id,["lead_owner_contact","lead_bedrooms","lead_property_type","lead_acquisition_source","lead_current_ota_count"],locale,env));
  expect(result.bindings.get("lead_owner_contact")).toEqual({kind:"TEXT",value:f.input.fields.ownerContact,privacy:["sensitive"]});expect(result.bindings.get("lead_bedrooms")).toEqual({kind:"INTEGER",value:String(f.input.fields.bedrooms),privacy:["sensitive"]});
  expect(result.bindings.get("lead_property_type")).toMatchObject({value:f.policy.property_types[0].label[locale],privacy:["sensitive"]});expect(result.bindings.get("lead_acquisition_source")).toMatchObject({value:f.policy.sources[0].label[locale],privacy:["sensitive"]});expect(result.bindings.get("lead_current_ota_count")).toEqual({kind:"INTEGER",value:"0",privacy:["sensitive"]});
 });
 it("uses the latest real profile correction while preserving the original captured row and source history",async()=>{
  const f=await fixture(),before=await withTenant(db,f.organizationId,async tx=>({source:await nativeLeadDocumentSource(tx,f.organizationId,f.lead.id),tuple:await tx.$queryRaw`SELECT xmin::text,md5(to_jsonb(t)::text) AS body FROM lead t WHERE id=${f.lead.id}::uuid`})),draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,ownerContact:"Actually corrected native acquisition contact",bedrooms:7}},review=await reviewLeadProfile(f.ctx,draft,{db,env}),saved=await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed proposal source correction"},{db,env});
  const after=await withTenant(db,f.organizationId,async tx=>({source:await nativeLeadDocumentSource(tx,f.organizationId,f.lead.id),values:await nativeLeadDocumentBindings(tx,f.organizationId,f.lead.id,["lead_owner_contact","lead_bedrooms"],"fr",env),tuple:await tx.$queryRaw`SELECT xmin::text,md5(to_jsonb(t)::text) AS body FROM lead t WHERE id=${f.lead.id}::uuid`}));
  expect(after.source?.snapshot.profileRevisionId).toBe(saved.id);expect(after.source?.snapshot).not.toEqual(before.source?.snapshot);expect(after.tuple).toEqual(before.tuple);expect(after.values.bindings.get("lead_owner_contact")).toMatchObject({value:draft.fields.ownerContact});expect(after.values.bindings.get("lead_bedrooms")).toMatchObject({value:"7"});
 });
 it("does not resolve or decrypt another tenant's native lead",async()=>{
  const f=await fixture(),foreign=await fixture();expect(await withTenant(db,foreign.organizationId,tx=>nativeLeadDocumentSource(tx,foreign.organizationId,f.lead.id))).toBeNull();await expect(withTenant(db,foreign.organizationId,tx=>nativeLeadDocumentBindings(tx,foreign.organizationId,f.lead.id,["lead_owner_contact"],"fr",env))).rejects.toThrow("document_template_binding_unavailable");
 });
 it.each(["lead_notes","referral_email","transaction_amount"])("refuses the unapproved private or financial binding %s",async key=>{
  const f=await fixture();await expect(withTenant(db,f.organizationId,tx=>nativeLeadDocumentBindings(tx,f.organizationId,f.lead.id,[key],"fr",env))).rejects.toThrow("document_template_binding_unavailable");
 });
 it("does not invent absent contact values or empty-list prose",async()=>{
  const f=await fixture();expect(f.input.fields.phone).toBeUndefined();for(const key of["lead_phone","lead_current_otas"])await expect(withTenant(db,f.organizationId,tx=>nativeLeadDocumentBindings(tx,f.organizationId,f.lead.id,[key],"en",env))).rejects.toThrow("document_template_binding_unavailable");
 });
 it("fences a current capture-rule replacement without rewriting the actual original capture",async()=>{
  const f=await fixture(),before=await withTenant(db,f.organizationId,tx=>nativeLeadDocumentSource(tx,f.organizationId,f.lead.id)),replacement=await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"crm.lead_capture",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.policy,rate_limit:{requests:101,window_seconds:3600}},reason:"Actual independently approved proposal source configuration replacement"})),after=await withTenant(db,f.organizationId,tx=>nativeLeadDocumentSource(tx,f.organizationId,f.lead.id));
  expect(after?.snapshot.capturePolicyId).toBe(replacement.id);expect(after?.snapshot.capturePolicyFingerprint).not.toBe(before?.snapshot.capturePolicyFingerprint);expect(after?.lead.policySnapshot).toEqual(before?.lead.policySnapshot);expect(after?.lead.encryptedPayload).toEqual(before?.lead.encryptedPayload);
 });
});
