import {randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
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
import {reviewLeadStage,admitLeadStage} from "@/modules/crm/application/lead-stage-service";
import {reviewDocumentTemplate,admitDocumentTemplate} from "@/modules/documents/application/document-template-authoring";
import {completeDocumentParts,downloadDocumentVersion,readDocumentHistory,documentArchiveContext} from "@/modules/documents/application/document-archive";
import {reviewDocumentGeneration} from "@/modules/documents/application/document-generation-review";
import {admitDocumentGeneration,recoverDocumentGeneration} from "@/modules/documents/application/document-generation-admission";
import {executeDocumentGenerationReference} from "@/modules/documents/application/document-generation-worker";
import {publishDocumentGeneration} from "@/modules/documents/application/document-generation-publication";
import {DocumentObjectStore} from "@/modules/documents/infrastructure/document-object-store";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentGenerationSnapshotSchema,documentGenerationRequested} from "@/modules/documents/domain/document-generation";
import {openDocumentGenerationInput} from "@/modules/documents/infrastructure/document-generation-payload";
import {nativeSignatureContext} from "@/modules/documents/application/document-signature-draft";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {renderOwnedProposal} from "./support/owned-proposal-renderer";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
let server:Server,base:string;
const encryptedObjects=new Map<string,Buffer>(),objects=()=>new DocumentObjectStore({createSignedUploadUrl:({key})=>Promise.resolve({url:base+"/"+key}),createSignedDownloadUrl:({key})=>Promise.resolve({url:base+"/"+key})},fetch,env);
const rendererToken=randomBytes(32).toString("base64url"),organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"proposal-native:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{const url=process.env.TEST_DATABASE_URL,target=url?new URL(url):null;if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_crm_proposal")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned native proposal database required");admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financial=await nativeLeadFinancialGuard(admin,db);});
beforeAll(async()=>{server=createServer((request,response)=>{void(async()=>{const key=request.url!;if(request.method==="POST"&&key==="/render"){await renderOwnedProposal(request,response,rendererToken);return;}if(request.method==="PUT"){if(request.headers["if-none-match"]!=="*"){response.writeHead(400).end();return;}const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));if(encryptedObjects.has(key))response.writeHead(412).end();else{encryptedObjects.set(key,Buffer.concat(chunks));response.writeHead(200).end();}}else{const bytes=encryptedObjects.get(key);if(bytes)response.writeHead(200,{"content-length":bytes.length}).end(bytes);else response.writeHead(404).end();}})().catch(()=>response.destroy());});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Owned acquisition document transport required");base="http://127.0.0.1:"+address.port;env.PDF_RENDERER_ENDPOINT=base+"/render";env.PDF_RENDERER_TOKEN=rendererToken;});
afterAll(async()=>{vi.restoreAllMocks();try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}});
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
type DocumentFixture=Awaited<ReturnType<typeof documentFixture>>;
async function proposal(f:DocumentFixture,locale:"en"|"fr"|"ar"="fr"){
 const variants=[];for(const language of["en","fr","ar"] as const){const draft={documentId:null,source:{kind:"ORGANIZATION",id:f.organizationId},typeKey:"acquisition_proposal",title:"Actual approved "+language+" acquisition proposal",supersedesId:null,effectiveFrom:null,definition:definition(language)},review=await reviewDocumentTemplate(f.ctx,draft,{db,env}),admitted=await admitDocumentTemplate(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual explicitly approved native proposal language"},{db,env}),completed=await completeDocumentParts(f.ctx,{admissionId:admitted.id},{db,env,objects:objects()});expect(completed.version?.id).toBeTruthy();variants.push({locale:language,versionId:completed.version!.id});}
 const selected=variants.find(variant=>variant.locale===locale)!;const draft={templateVersionId:selected.versionId,variantVersionIds:variants.map(variant=>variant.versionId),source:{kind:"LEAD",id:f.lead.id},title:"Actual retained acquisition proposal "+locale,effectiveFrom:null},review=await reviewDocumentGeneration(f.ctx,draft,{db,env}),command={...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed native acquisition proposal"},admitted=await admitDocumentGeneration(f.ctx,command,{db,env}),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{organizationId:f.organizationId,type:documentGenerationRequested,payload:{path:["instanceId"],equals:admitted.id}}}));
 return{draft,command,admitted,reference:{organizationId:f.organizationId,outboxEventId:event.id}};
}

describe("native acquisition document source composition",()=>{
 it.each(["en","fr","ar"] as const)("publishes and downloads an actual encrypted %s lead proposal from approved native template variants",async locale=>{
  const f=await documentFixture(),generated=await proposal(f,locale),instance=await withTenant(db,f.organizationId,tx=>tx.documentInstance.findFirstOrThrow({where:{id:generated.admitted.id}})),snapshot=documentGenerationSnapshotSchema.parse(instance.sourceSnapshot),input=openDocumentGenerationInput(snapshot.identity,Buffer.from(snapshot.payloadCipher,"base64"),env);expect(input.source.title).toBe(f.input.fields.ownerContact);expect(input.source.locale).toBe(locale);expect(input.source.privacy).toContain("sensitive");
  const complete=await executeDocumentGenerationReference(generated.reference,{db,env,objects:objects()});expect(complete.state).toBe("COMPLETE");expect(complete.versionId).toBeTruthy();const downloaded=await downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:objects()});expect(Buffer.from(downloaded.bytes).subarray(0,5).toString()).toBe("%PDF-");
  const loading=getDocument({data:new Uint8Array(downloaded.bytes),useSystemFonts:false}),pdf=await loading.promise;try{const page=await pdf.getPage(1),text=await page.getTextContent();expect(text.items.filter(item=>"str" in item).map(item=>item.str).join(" ")).toContain(f.input.fields.ownerContact);}finally{await loading.destroy();}
  const root=await withTenant(db,f.organizationId,tx=>tx.document.findFirstOrThrow({where:{id:complete.documentId}}));expect(root).toMatchObject({sourceKind:"LEAD",sourceId:f.lead.id,leadId:f.lead.id,locale,kind:"INSTANCE",privacy:["sensitive"]});expect((await recoverDocumentGeneration(f.ctx,{idempotencyKey:generated.command.idempotencyKey},{db,env})).versionId).toBe(complete.versionId);expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:root.id}}))).toBe(1);
 });
 it("advances the real pipeline using the actual effective native proposal PDF without caller completion flags",async()=>{
  const f=await documentFixture();let previousRevisionId:string|null=null;for(const toStage of["CONTACTED","QUALIFIED","PROPERTY_ASSESSMENT"] as const){const draft={leadId:f.lead.id,previousRevisionId,toStage,evidenceReferences:[]},review=await reviewLeadStage(f.ctx,draft,{db,env}),saved=await admitLeadStage(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual configured acquisition progress"},{db,env});previousRevisionId=saved.id;}
  const generated=await proposal(f),complete=await executeDocumentGenerationReference(generated.reference,{db,env,objects:objects()}),draft={leadId:f.lead.id,previousRevisionId,toStage:"PROPOSAL",evidenceReferences:[{kind:"PROPOSAL_VERSION",sourceId:complete.versionId}]},review=await reviewLeadStage(f.ctx,draft,{db,env}),saved=await admitLeadStage(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Reference the actual effective approved proposal"},{db,env});expect(saved.toStage).toBe("PROPOSAL");expect(await withTenant(db,f.organizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{id:saved.id}}))).toMatchObject({toStage:"PROPOSAL"});
 });
 it("retains the original published PDF and effective history after an actual profile correction",async()=>{
  const f=await documentFixture(),generated=await proposal(f),complete=await executeDocumentGenerationReference(generated.reference,{db,env,objects:objects()}),original=await downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:objects()}),draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,ownerContact:"Actual later corrected proposal contact"}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual retained source correction after proposal publication"},{db,env});expect((await downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:objects()})).bytes).toEqual(original.bytes);expect(await readDocumentHistory(f.ctx,{documentId:complete.documentId},{db,env})).toMatchObject({document:{id:complete.documentId}});
 });
 it("withholds publication of a pending original after its actual lead profile changes",async()=>{
  const f=await documentFixture(),generated=await proposal(f),draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,bedrooms:8}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual source change before pending proposal publication"},{db,env});await expect(publishDocumentGeneration(f.ctx,{instanceId:generated.admitted.id},{db,env,objects:objects()})).rejects.toThrow("document_source_changed");expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:generated.admitted.documentId}}))).toBe(0);expect(await recoverDocumentGeneration(f.ctx,{idempotencyKey:generated.command.idempotencyKey},{db,env})).toMatchObject({recorded:true,state:"SOURCE_CHANGED",versionId:null});
 });
 it("keeps native lead signing closed before the F-CRM-06 recipient producer while preserving authorized archive reads",async()=>{
  const f=await documentFixture(),generated=await proposal(f),complete=await executeDocumentGenerationReference(generated.reference,{db,env,objects:objects()});await withTenant(db,f.organizationId,tx=>tx.person.update({where:{id:f.person.id},data:{email:"actual-proposal-signer@example.test"}}));await withTenant(db,f.organizationId,async tx=>{const repository=new DocumentRepository(tx,f.organizationId),instance=await repository.instance(generated.admitted.id);expect(instance).toBeTruthy();await documentArchiveContext(f.ctx,tx,{kind:"LEAD",id:f.lead.id},"export",instance!.document);});const spy=vi.spyOn(DocumentRepository.prototype,"signatureRecipientSource");try{await expect(withTenant(db,f.organizationId,tx=>nativeSignatureContext(f.ctx,tx,{instanceId:generated.admitted.id,documentVersionId:complete.versionId!,recipients:[{kind:"PERSON",id:f.person.id}]},"view"))).rejects.toThrow("document_configuration_unavailable");expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
 });
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
