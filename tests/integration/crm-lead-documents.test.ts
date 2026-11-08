import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeLeadDocumentSource,nativeLeadDocumentBindings} from "@/platform/documents/lead-source";
import {nativeLeadFixture,nativeLeadInput,nativeLeadProfileFixture,nativeLeadFinancialGuard} from "./support/lead-fixture";
import {captureLead} from "@/modules/crm/application/lead-capture-service";
import {provisionIntegrationRole} from "./support/database-role";
import {authContextForAccount} from "@/platform/authz/account-context";
import * as auditWriter from "@/platform/audit/audit-writer";
import {resolveDocumentTemplateValues} from "@/modules/documents/application/document-template-values";
import {readDocumentSources,readDocumentSourceWorkspace} from "@/modules/documents/application/document-workspace";
import {documentTemplateMediaType} from "@/modules/documents/domain/document-template-format";
import {reviewLeadProfile,admitLeadProfile} from "@/modules/crm/application/lead-profile-service";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[],env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"proposal-native:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{const url=process.env.TEST_DATABASE_URL,target=url?new URL(url):null;if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_crm_proposal")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned native proposal database required");admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financial=await nativeLeadFinancialGuard(admin,db);});
afterAll(async()=>{vi.restoreAllMocks();try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(){const f=await nativeLeadProfileFixture(admin,db,env);organizations.push(f.organizationId);return f;}
const definition=(locale:"en"|"fr"|"ar"="fr")=>({schemaVersion:1,templateKey:"acquisition_proposal",locale,title:"{{lead_owner_contact}}",variables:[{key:"lead_owner_contact",kind:"TEXT"},{key:"lead_property_type",kind:"TEXT"},{key:"lead_bedrooms",kind:"INTEGER"}],blocks:[{kind:"PARAGRAPH",text:"{{lead_owner_contact}} / {{lead_property_type}} / {{lead_bedrooms}}"}]});
async function documentFixture(){
 const f=await fixture(),grants=await withTenant(db,f.organizationId,async tx=>{
  const result:Record<string,string>={"lead:view":f.assignments.view};
  for(const key of["lead:export","document:view","document:create","document:edit","document:export","document_template:view","document_template:create","document_template:edit","document_template:export","document_instance:view","document_instance:create","document_instance:edit","document_instance:export","organization:view","organization:export","signature:view","signature:create","team_member:view","team_member:export","staff_document:view","staff_document:export"]){
   const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_proposal_"+randomUUID(),name:"Independent actual proposal "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});result[key]=assignment.id;
  }
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"documents.archive",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit approved native acquisition document types",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,upload_admission:{window_seconds:3600,max_requests:100},upload_transport:{window_seconds:3600,max_requests:100},types:[{key:"acquisition_proposal",labels:{en:"Approved acquisition proposal",fr:"Proposition approuvée",ar:"عرض معتمد"},sources:["ORGANIZATION","LEAD"],privacy:["sensitive"],content_types:["application/pdf",documentTemplateMediaType],max_bytes:1048576}]}});
  return result;
 });return{...f,originalHeld:f.ctx,grants,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}}};
}

describe("native acquisition document source composition",()=>{
 it.each(["en","fr","ar"] as const)("resolves approved %s proposal values through actual document and native lead authorization",async locale=>{
  const f=await documentFixture(),result=await resolveDocumentTemplateValues(f.ctx,{kind:"LEAD",id:f.lead.id},definition(locale),"acquisition_proposal",{db,env});
  expect(result.rendered.title).toBe(f.input.fields.ownerContact);expect(result.rendered.privacy).toContain("sensitive");expect(JSON.stringify(result.rendered)).toContain(f.policy.property_types[0].label[locale]);expect(result.sourceReference).toEqual({kind:"LEAD",id:f.lead.id});expect(result.nativeSourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
 });
 it.each(["lead:view","lead:export","document:export","document_instance:export"])("requires the actual current independent %s grant for proposal values",async key=>{
  const f=await documentFixture();await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{validTo:new Date("2020-01-02")}}));await expect(resolveDocumentTemplateValues(f.ctx,{kind:"LEAD",id:f.lead.id},definition(),"acquisition_proposal",{db,env})).rejects.toThrow("document_unavailable");
 });
 it("does not borrow newly stored document/export grants for the earlier held lead-only actor",async()=>{
  const f=await documentFixture();await expect(resolveDocumentTemplateValues(f.originalHeld,{kind:"LEAD",id:f.lead.id},definition(),"acquisition_proposal",{db,env})).rejects.toThrow("document_unavailable");
 });
 it("keeps proposal rendering unavailable to an independently authorized foreign tenant",async()=>{
  const f=await documentFixture(),foreign=await documentFixture();await expect(resolveDocumentTemplateValues(foreign.ctx,{kind:"LEAD",id:f.lead.id},definition(),"acquisition_proposal",{db,env})).rejects.toThrow("document_unavailable");
 });
 it("uses the existing native document workspace and conceals lead identifiers after actual view withdrawal",async()=>{
  const f=await documentFixture(),source={kind:"LEAD",id:f.lead.id};expect((await readDocumentSources(f.ctx,{kind:"LEAD",query:f.lead.id},{db,env})).items.map(row=>row.source)).toEqual([source]);expect(await readDocumentSourceWorkspace(f.ctx,{source},{db,env})).toMatchObject({source,items:[],types:[{key:"acquisition_proposal"}]});await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["lead:view"]},data:{validTo:new Date("2020-01-02")}}));expect((await readDocumentSources(f.ctx,{kind:"LEAD",query:f.lead.id},{db,env})).items).toEqual([]);
 });
 it("withholds source workspace publication after actual lead-view withdrawal at its read-audit boundary",async()=>{
  const f=await documentFixture(),original=auditWriter.writeAuditEvent;let withdrawn=false;const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await original(tx,event);if(!withdrawn&&event.action==="documents.source_read"){withdrawn=true;await withTenant(db,f.organizationId,other=>other.roleAssignment.update({where:{id:f.grants["lead:view"]},data:{validTo:new Date("2020-01-02")}}));}return result;});
  try{await expect(readDocumentSourceWorkspace(f.ctx,{source:{kind:"LEAD",id:f.lead.id}},{db,env})).rejects.toThrow("document_unavailable");}finally{spy.mockRestore();}expect(withdrawn).toBe(true);expect(await withTenant(db,f.organizationId,tx=>tx.auditLog.count({where:{action:"documents.source_read"}}))).toBe(0);
 });
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
