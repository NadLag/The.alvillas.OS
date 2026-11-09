import {nativeLeadContractFixtures} from "./support/lead-contract-fixture";
import {randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeLeadFinancialGuard,nativeLeadInput} from "./support/lead-fixture";
 
import {provisionIntegrationRole} from "./support/database-role";
 
 
 
 
 
 
import {DocumentObjectStore} from "@/modules/documents/infrastructure/document-object-store";
import {reviewNativeSignature,admitNativeSignature,recoverNativeSignature,readNativeSignatureChoices} from "@/modules/documents/application/document-signature-draft";
import {readNativeSignatureHistory} from "@/modules/documents/application/document-signature-history";
import {nativeSignatureRecipientIdentitySchema,nativeSignatureSnapshotSchema} from "@/modules/documents/domain/document-signature-command";
import {openNativeSignatureRecipient} from "@/modules/documents/infrastructure/document-signature-recipient-payload";
import {captureLead} from "@/modules/crm/application/lead-capture-service";
import {reviewLeadProfile,admitLeadProfile} from "@/modules/crm/application/lead-profile-service";
import * as leadSources from "@/platform/documents/lead-source";
 
 
import {recoverSignaturePreparation} from "@/modules/documents/application/document-signature-preparation";
import {executeSignaturePreparationReference} from "@/modules/documents/application/document-signature-preparation-worker";
import {reviewSignatureDistribution} from "@/modules/documents/application/document-signature-distribution";
import {executeSignatureDistributionReference} from "@/modules/documents/application/document-signature-distribution-worker";
 
 
import {executeSignedArchiveReference} from "@/modules/documents/application/document-signed-archive-worker";
import {signedArchiveOutboxKey} from "@/modules/documents/application/document-signed-archive-admission";
import {SignedSignatureRepository} from "@/modules/documents/infrastructure/signed-signature-repository";
import {downloadDocumentVersion,readDocumentHistory,documentJson} from "@/modules/documents/application/document-archive";
import {nativeLeadStageEvidence} from "@/platform/documents/lead-stage-evidence";
import type {ownedSignatureProvider} from "./support/document-signature-provider";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {createElement} from "react";
import {Document as PdfDocument,Page as PdfPage,Text as PdfText,renderToBuffer} from "@react-pdf/renderer";

let admin:PrismaClient,db:PrismaClient,server:Server,base:string,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const providers:Array<Awaited<ReturnType<typeof ownedSignatureProvider>>>=[];
const organizations:string[]=[],env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"contract-native:"+randomBytes(32).toString("base64")},encrypted=new Map<string,Buffer>(),objects=()=>new DocumentObjectStore({createSignedUploadUrl:({key})=>Promise.resolve({url:base+"/"+key}),createSignedDownloadUrl:({key})=>Promise.resolve({url:base+"/"+key})},fetch,env);
beforeAll(async()=>{const raw=process.env.TEST_DATABASE_URL,target=raw?new URL(raw):null;if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_crm_contract")||target.pathname.startsWith("/alvillas_automation_crm_proposal_contract")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned native lead-contract database required");admin=new PrismaClient({datasourceUrl:raw});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(raw!);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financial=await nativeLeadFinancialGuard(admin,db);});
beforeAll(async()=>{server=createServer((request,response)=>{void(async()=>{const key=request.url!;if(request.method==="PUT"){if(request.headers["if-none-match"]!=="*"){response.writeHead(400).end();return;}const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));if(encrypted.has(key))response.writeHead(412).end();else{encrypted.set(key,Buffer.concat(chunks));response.writeHead(200).end();}}else{const bytes=encrypted.get(key);if(bytes)response.writeHead(200,{"content-length":bytes.length}).end(bytes);else response.writeHead(404).end();}})().catch(()=>response.destroy());});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Owned encrypted contract transport required");base="http://127.0.0.1:"+address.port;});
afterAll(async()=>{vi.restoreAllMocks();try{if(financial)await financial.assertPreserved(organizations);}finally{for(const provider of providers)await provider.close();await db?.$disconnect();await admin?.$disconnect();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}});

describe("native lead contract signer",()=>{
 it("admits and recovers the original encrypted native signer without creating an Owner",async()=>{
  const f=await fixture(),ownersBefore=await withTenant(db,f.organizationId,tx=>tx.owner.count()),{review,command,saved}=await admit(f);expect(review.recipients).toMatchObject([{reference:{kind:"LEAD",id:f.lead.id},displayName:f.input.fields.ownerContact,email:f.input.fields.email}]);
  const row=await withTenant(db,f.organizationId,tx=>tx.signatureRecipient.findFirstOrThrow({where:{signatureId:saved.id}})),identity=nativeSignatureRecipientIdentitySchema.parse((row.sourceSnapshot as {identity:unknown}).identity);expect(row).toMatchObject({leadId:f.lead.id,personId:null,ownerId:null,guestId:null,supplierId:null});expect(Buffer.from(row.emailCipher).includes(Buffer.from(f.input.fields.email!))).toBe(false);expect(openNativeSignatureRecipient(identity,row.emailCipher,env)).toMatchObject({displayName:f.input.fields.ownerContact,email:f.input.fields.email});expect((await recoverNativeSignature(f.ctx,{idempotencyKey:command.idempotencyKey},{db,env})).id).toBe(saved.id);expect((await admitNativeSignature(f.ctx,command,{db,env})).id).toBe(saved.id);expect(await withTenant(db,f.organizationId,tx=>tx.signature.count({where:{commandKey:command.idempotencyKey}}))).toBe(1);expect(await withTenant(db,f.organizationId,tx=>tx.owner.count())).toBe(ownersBefore);expect((await readNativeSignatureHistory(f.ctx,{signatureId:saved.id},{db,env})).recipients).toMatchObject([{displayName:f.input.fields.ownerContact,email:f.input.fields.email}]);
 });
 it.each(["lead:view","lead:export","document:export","document_instance:export","signature:view","signature:create"])("requires actual independent current %s authority",async key=>{
  const f=await fixture(),review=await reviewNativeSignature(f.ctx,f.draft,{db,env});await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{validTo:new Date("2020-01-02")}}));if(key==="signature:create")await expect(admitNativeSignature(f.ctx,{...f.draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Cannot borrow withdrawn actual create authority"},{db,env})).rejects.toThrow("document_unavailable");else await expect(reviewNativeSignature(f.ctx,f.draft,{db,env})).rejects.toThrow("document_unavailable");expect(await withTenant(db,f.organizationId,tx=>tx.signature.count())).toBe(0);
 });
 it("does not borrow stored document and signature grants for an earlier held actor",async()=>{const f=await fixture(),spy=vi.spyOn(leadSources,"nativeLeadDocumentContact");try{await expect(reviewNativeSignature(f.originalHeld,f.draft,{db,env})).rejects.toThrow("document_unavailable");expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}});
 it("rejects another actual lead as the contract party before decrypting its contact",async()=>{const f=await fixture(),other=await captureLead(f.ctx,nativeLeadInput(),{db,env}),spy=vi.spyOn(leadSources,"nativeLeadDocumentContact");try{await expect(reviewNativeSignature(f.ctx,{...f.draft,recipients:[{kind:"LEAD",id:other.id}]},{db,env})).rejects.toThrow("document_unavailable");expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}});
 it("offers only the actual owning lead through the native signature choice boundary",async()=>{const f=await fixture();await captureLead(f.ctx,nativeLeadInput(),{db,env});expect((await readNativeSignatureChoices(f.ctx,{documentVersionId:f.versionId,kind:"LEAD",query:f.input.fields.ownerContact},{db,env})).items).toMatchObject([{reference:{kind:"LEAD",id:f.lead.id},email:f.input.fields.email}]);expect((await readNativeSignatureChoices(f.ctx,{documentVersionId:f.versionId,kind:"LEAD",query:"Different actual contact"},{db,env})).items).toEqual([]);});
 it("retains original signer history after a native contact correction and closes pending provider inputs",async()=>{
  const f=await fixture(),{saved,command}=await admit(f),draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,ownerContact:"Actually corrected contract contact",email:"corrected-contract@example.test"}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual retained native contact correction after signature admission"},{db,env});expect((await recoverNativeSignature(f.ctx,{idempotencyKey:command.idempotencyKey},{db,env})).state).toBe("SOURCE_CHANGED");expect((await readNativeSignatureHistory(f.ctx,{signatureId:saved.id},{db,env})).recipients).toMatchObject([{displayName:f.input.fields.ownerContact,email:f.input.fields.email}]);
 });
 it("retains original contract approval while a replacement closes pending provider inputs",async()=>{
  const f=await fixture(),{saved,command}=await admit(f);await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"crm.pipeline",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.stagePolicy,admission:{requests:101,window_seconds:3600}},reason:"Actual independently approved pipeline policy replacement"}));expect((await recoverNativeSignature(f.ctx,{idempotencyKey:command.idempotencyKey},{db,env})).state).toBe("SOURCE_CHANGED");expect((await readNativeSignatureHistory(f.ctx,{signatureId:saved.id},{db,env})).signature.id).toBe(saved.id);
 });
 it("keeps proposal signing closed when only the configured contract type is approved",async()=>{const f=await fixture("acquisition_proposal"),spy=vi.spyOn(leadSources,"nativeLeadDocumentContact");try{await expect(reviewNativeSignature(f.ctx,f.draft,{db,env})).rejects.toThrow("document_configuration_unavailable");expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}});
});

describe("native Lead provider flow",()=>{
 it("prepares and sends the exact native contract once and supplies actual SENT stage evidence",async()=>{
  const f=await providerFixture(),sent=await prepareAndSend(f),calls=f.http.calls.filter(call=>call.method==="POST").length;
  expect((await recoverSignaturePreparation(f.ctx,{idempotencyKey:f.preparation.command.idempotencyKey},f.deps)).state).toBe("PREPARED");await executeSignaturePreparationReference(f.preparation.reference,f.deps);await executeSignatureDistributionReference(sent.reference,f.deps);expect(f.http.calls.filter(call=>call.method==="POST")).toHaveLength(calls);
  expect((await readNativeSignatureHistory(f.ctx,{signatureId:f.signature.saved.id},f.deps)).signature.state).toBe("SENT");
  const event=await withTenant(db,f.organizationId,tx=>tx.signatureEvent.findFirstOrThrow({where:{signatureId:f.signature.saved.id,state:"SENT"}})),proofs=await withTenant(db,f.organizationId,tx=>nativeLeadStageEvidence(f.ctx,tx,{leadId:f.lead.id,previousRevisionId:null,toStage:"SENT",evidenceReferences:[{kind:"CONTRACT_VERSION",sourceId:f.versionId},{kind:"SIGNATURE_SENT",sourceId:event.id}]},["CONTRACT_VERSION","SIGNATURE_SENT"],f.stagePolicy,new Date(),{env:f.deps.env}));
  expect(proofs.map(proof=>proof.kind)).toEqual(["CONTRACT_VERSION","SIGNATURE_SENT"]);expect(proofs.every(proof=>proof.leadId===f.lead.id)).toBe(true);expect(await withTenant(db,f.organizationId,tx=>tx.owner.count())).toBe(0);
 });
 it.each(["contact","contractPolicy","authority"] as const)("closes pending provider creation after an actual %s change without a POST",async change=>{
  const f=await providerFixture(),posts=f.http.calls.filter(call=>call.method==="POST").length;
  if(change==="contact"){const draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,ownerContact:"Changed actual provider signer",email:"changed-before-provider@example.test"}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed signer correction before provider creation"},{db,env});}
  else if(change==="contractPolicy")await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"crm.pipeline",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.stagePolicy,admission:{requests:102,window_seconds:3600}},reason:"Actual contract approval replacement before provider creation"}));
  else await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["lead:export"]},data:{validTo:new Date("2020-01-02")}}));
  await expect(executeSignaturePreparationReference(f.preparation.reference,f.deps)).rejects.toThrow(change==="authority"?"document_unavailable":"document_source_changed");expect(f.http.calls.filter(call=>call.method==="POST")).toHaveLength(posts);expect(await withTenant(db,f.organizationId,tx=>tx.signatureProviderAttempt.count({where:{signatureId:f.signature.saved.id}}))).toBe(0);
 });
 it("archives the actual signed contract and certificate and supplies VIEWED/SIGNED native stage evidence",async()=>{
  const f=await providerFixture();await prepareAndSend(f);f.http.state.lifecycle.readStatus="OPENED";await callback(f,"DOCUMENT_OPENED");
  const original=await downloadDocumentVersion(f.ctx,{versionId:f.versionId},f.deps),task=getDocument({data:new Uint8Array(original.bytes),useSystemFonts:false,useWorkerFetch:false,useWasm:false,disableFontFace:true,verbosity:0}),pages=[];
  try{const pdf=await task.promise;for(let number=1;number<=pdf.numPages;number++){const page=await pdf.getPage(number),box=page.getViewport({scale:1}),text=(await page.getTextContent()).items.map(item=>"str" in item?item.str:"").join(" ");pages.push(createElement(PdfPage,{key:number,size:[box.width,box.height]},createElement(PdfText,{style:{fontSize:8}},text),createElement(PdfText,{style:{fontSize:8}},"Owned actual native Lead signing representation; technical fixture only")));}}finally{await task.destroy();}
  f.http.state.signedPdf=new Uint8Array(await renderToBuffer(createElement(PdfDocument,{},...pages)));f.http.state.certificatePdf=new Uint8Array(await renderToBuffer(createElement(PdfDocument,{},createElement(PdfPage,{size:"A4"},createElement(PdfText,{},"Owned native Lead provider completion certificate; no legal acceptance claim")))));f.http.state.lifecycle={status:"COMPLETED",readStatus:"OPENED",signingStatus:"SIGNED",signedAt:new Date().toISOString(),completedAt:new Date().toISOString()};await callback(f,"DOCUMENT_COMPLETED");
  const archive=await withTenant(db,f.organizationId,tx=>new SignedSignatureRepository(tx,f.organizationId).signedArchiveForSignature(f.signature.saved.id));if(!archive)throw Error("Actual retained native Lead completion must admit its signed archive");const work=await reference(f.organizationId,signedArchiveOutboxKey(archive.id));expect((await executeSignedArchiveReference(work,f.deps)).state).toBe("COMPLETE");
  const completed=await withTenant(db,f.organizationId,tx=>new SignedSignatureRepository(tx,f.organizationId).signedArchive(archive.id));expect(completed!.artifacts).toHaveLength(2);for(const asset of completed!.artifacts){expect(asset.document.leadId).toBe(f.lead.id);expect((await downloadDocumentVersion(f.ctx,{versionId:asset.admission.version!.id},f.deps)).bytes).toEqual(Buffer.from(asset.kind==="SIGNED_ORIGINAL"?f.http.state.signedPdf:f.http.state.certificatePdf));expect((await readDocumentHistory(f.ctx,{documentId:asset.documentId},f.deps)).document.signedArtifact).toMatchObject({signatureId:f.signature.saved.id,originalVersionId:f.versionId});}
  const events=await withTenant(db,f.organizationId,tx=>tx.signatureEvent.findMany({where:{signatureId:f.signature.saved.id,state:{in:["SENT","VIEWED"]}}})),sent=events.find(event=>event.state==="SENT")!,viewed=events.find(event=>event.state==="VIEWED")!,proofs=await withTenant(db,f.organizationId,tx=>nativeLeadStageEvidence(f.ctx,tx,{leadId:f.lead.id,previousRevisionId:null,toStage:"SIGNED",evidenceReferences:[{kind:"CONTRACT_VERSION",sourceId:f.versionId},{kind:"SIGNATURE_SENT",sourceId:sent.id},{kind:"SIGNATURE_VIEWED",sourceId:viewed.id},{kind:"SIGNATURE_SIGNED_ARCHIVE",sourceId:archive.id}]},["CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE"],f.stagePolicy,new Date(),{env:f.deps.env}));expect(proofs.map(proof=>proof.kind)).toEqual(["CONTRACT_VERSION","SIGNATURE_SENT","SIGNATURE_VIEWED","SIGNATURE_SIGNED_ARCHIVE"]);expect((await readNativeSignatureHistory(f.ctx,{signatureId:f.signature.saved.id},f.deps)).signature.state).toBe("SIGNED");
  const calls=f.http.calls.length;await executeSignedArchiveReference(work,f.deps);expect(f.http.calls).toHaveLength(calls);expect((await downloadDocumentVersion(f.ctx,{versionId:f.versionId},f.deps)).bytes).toEqual(original.bytes);expect(await withTenant(db,f.organizationId,tx=>tx.owner.count())).toBe(0);
 });
});

describe("native Lead contract guard regressions",()=>{
 it.each(["missing","rule","version","types"] as const)("the actual deferred database guard rejects a substituted %s contract approval",async change=>{
  const f=await fixture(),review=await reviewNativeSignature(f.ctx,f.draft,{db,env});let active:TenantTransaction|undefined,checkedCreates=0;
  const guarded=db.$extends({query:{signature:{async create({args,query}){
   const snapshot=nativeSignatureSnapshotSchema.parse(args.data.policySnapshot);if(!snapshot.leadContractPolicy)throw Error("Actual captured native contract policy required");
   if(change==="missing")delete snapshot.leadContractPolicy;else if(change==="rule")snapshot.leadContractPolicy.id=randomUUID();else if(change==="version")snapshot.leadContractPolicy.version++;else snapshot.leadContractPolicy.contractTypeKeys=["not_an_approved_contract"];
   args.data.policySnapshot=documentJson(snapshot);const row=await query(args);checkedCreates++;if(!active)throw Error("Actual active native transaction required");await active.$executeRawUnsafe("SET CONSTRAINTS native_signature_draft_guard IMMEDIATE");return row;
  }}}}),checked:TenantTransactionRunner={$transaction:(work,options)=>guarded.$transaction(async tx=>{
   // Prisma's query-only extension changes generated generic arguments, not the transaction's models or results.
   const platformTx=tx as unknown as TenantTransaction;active=platformTx;try{return await work(platformTx);}finally{active=undefined;}
  },options)};
  await expect(admitNativeSignature(f.ctx,{...f.draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual native deferred guard rejects an unretained approval"},{db:checked,env})).rejects.toThrow("native lead signature requires its approved contract policy and owning signer");expect(checkedCreates).toBe(1);
  expect(await withTenant(db,f.organizationId,tx=>tx.signature.count())).toBe(0);expect(await withTenant(db,f.organizationId,tx=>tx.signatureRecipient.count())).toBe(0);expect(await withTenant(db,f.organizationId,tx=>tx.outboxEvent.count({where:{type:"documents.signature.draft_created"}}))).toBe(0);
 });
 it("keeps the actual new native Lead recipient append-only",async()=>{
  const f=await fixture(),{saved}=await admit(f),recipient=await withTenant(db,f.organizationId,tx=>tx.signatureRecipient.findFirstOrThrow({where:{signatureId:saved.id}}));
  await expect(withTenant(db,f.organizationId,tx=>tx.signatureRecipient.update({where:{id:recipient.id},data:{leadId:randomUUID()}}))).rejects.toThrow(/append.only/u);await expect(withTenant(db,f.organizationId,tx=>tx.signatureRecipient.delete({where:{id:recipient.id}}))).rejects.toThrow(/append.only/u);expect(await withTenant(db,f.organizationId,tx=>tx.signatureRecipient.findUniqueOrThrow({where:{id:recipient.id}}))).toEqual(recipient);
 });
 it("withholds actual foreign-tenant contracts and contact choices before decryption",async()=>{
  const f=await fixture(),foreign=await fixture(),spy=vi.spyOn(leadSources,"nativeLeadDocumentContact");try{await expect(reviewNativeSignature(foreign.ctx,f.draft,{db,env})).rejects.toThrow("document_unavailable");await expect(readNativeSignatureChoices(foreign.ctx,{documentVersionId:f.versionId,kind:"LEAD"},{db,env})).rejects.toThrow("document_unavailable");expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
 });
 it("does not invent a signer email when an actual reviewed contact correction removes it",async()=>{
  const f=await fixture(),draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,email:undefined,phone:"+212612345678"}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed phone contact with no email signing destination"},{db,env});await expect(reviewNativeSignature(f.ctx,f.draft,{db,env})).rejects.toThrow("document_configuration_unavailable");expect(await withTenant(db,f.organizationId,tx=>tx.signature.count())).toBe(0);
 });
 it("retains an actual provider creation receipt after a contact changes during its POST and prevents distribution",async()=>{
  const f=await providerFixture();f.http.state.afterCreate=async()=>{const draft={leadId:f.lead.id,previousRevisionId:null,sourceKey:f.input.sourceKey,locale:"fr",fields:{...f.input.fields,ownerContact:"Actually changed during provider creation",email:"changed-during-contract-post@example.test"}},review=await reviewLeadProfile(f.ctx,draft,{db,env});await admitLeadProfile(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual contact correction after the original provider effect began"},{db,env});};
  expect((await executeSignaturePreparationReference(f.preparation.reference,f.deps)).state).toBe("PREPARED");expect(f.http.requestId).not.toBeNull();const posts=f.http.calls.filter(call=>call.method==="POST").length;expect(posts).toBe(1);expect((await executeSignaturePreparationReference(f.preparation.reference,f.deps)).state).toBe("PREPARED");expect(f.http.calls.filter(call=>call.method==="POST")).toHaveLength(posts);await expect(reviewSignatureDistribution(f.ctx,{preparationId:f.preparation.receipt.id},f.deps)).rejects.toThrow("document_source_changed");expect((await readNativeSignatureHistory(f.ctx,{signatureId:f.signature.saved.id},f.deps)).recipients).toMatchObject([{displayName:f.input.fields.ownerContact,email:f.input.fields.email}]);expect(await withTenant(db,f.organizationId,tx=>tx.signatureProviderEvidence.count({where:{signatureId:f.signature.saved.id,kind:"PREPARED"}}))).toBe(1);expect(await withTenant(db,f.organizationId,tx=>tx.signatureEvent.count({where:{signatureId:f.signature.saved.id,state:"SENT"}}))).toBe(0);
 });
});

let fixture:ReturnType<typeof nativeLeadContractFixtures>["fixture"],admit:ReturnType<typeof nativeLeadContractFixtures>["admit"],reference:ReturnType<typeof nativeLeadContractFixtures>["reference"],providerFixture:ReturnType<typeof nativeLeadContractFixtures>["providerFixture"],prepareAndSend:ReturnType<typeof nativeLeadContractFixtures>["prepareAndSend"],callback:ReturnType<typeof nativeLeadContractFixtures>["callback"];
beforeAll(()=>{({fixture,admit,reference,providerFixture,prepareAndSend,callback}=nativeLeadContractFixtures({admin,db,env,objects,organizations,providers}));});
