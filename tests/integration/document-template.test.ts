import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient, type Prisma } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { openDocumentTemplatePayload } from "@/modules/documents/infrastructure/document-template-payload";
import { documentTemplateMediaType } from "@/modules/documents/domain/document-template-format";
import { encodeDocumentTemplate } from "@/modules/documents/domain/document-template";
import { reviewDocumentTemplate, admitDocumentTemplate, prepareDocumentTemplate } from "@/modules/documents/application/document-template-authoring";
import { completeDocumentParts, recoverDocumentUpload, downloadDocumentVersion, reviewDocumentUpload, admitDocumentUpload } from "@/modules/documents/application/document-archive";
import { provisionIntegrationRole } from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,server:Server,storageUrl:string;
const objects=new Map<string,Buffer>(),env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"template-native:"+randomBytes(32).toString("base64")};
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const json=(value:Prisma.JsonValue):Prisma.InputJsonValue=>{if(value===null)throw Error("Original non-null provenance required");return value;};
const store=(transport:typeof fetch=fetch,keys=env)=>new DocumentObjectStore({createSignedUploadUrl:({key})=>Promise.resolve({url:storageUrl+"/"+key}),createSignedDownloadUrl:({key})=>Promise.resolve({url:storageUrl+"/"+key})},transport,keys);
beforeAll(async()=>{
  const url=process.env.TEST_DATABASE_URL;if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname))throw Error("Owned local PostgreSQL required");
  admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  server=createServer((request,response)=>{void(async()=>{
    const key=request.url!;if(request.method==="PUT"){if(request.headers["if-none-match"]!=="*"){response.writeHead(400).end();return;}const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));if(objects.has(key))response.writeHead(412).end();else{objects.set(key,Buffer.concat(chunks));response.writeHead(200).end();}return;}
    const value=objects.get(key);if(value)response.writeHead(200,{"content-length":value.length}).end(value);else response.writeHead(404).end();
  })().catch(()=>response.destroy());});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Owned object transport required");storageUrl="http://127.0.0.1:"+address.port;
});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function fixture(budget=100){
  const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Native authored templates",baseCurrency:"MAD"}});await ensureStandardIdentitySetup(organizationId,{db});
  const property=await withTenant(db,organizationId,async tx=>{
    const property=await tx.property.create({data:{organizationId,name:"Original template villa",addressLine1:"Owned acceptance",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}});
    await new ConfigRuleRepository(tx,organizationId).createVersion({key:"documents.archive",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),reason:"Explicit authored template classification and transport policy",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,
      upload_admission:{window_seconds:3600,max_requests:100},upload_transport:{window_seconds:3600,max_requests:budget},types:[{key:"typed_agreement",labels:{en:"Authored agreement",fr:"Convention rédigée",ar:"اتفاقية محررة"},sources:["PROPERTY","FINANCIAL_TRANSACTION"],privacy:["financial"],content_types:[documentTemplateMediaType,"application/pdf"],max_bytes:1048576}]}});return property;
  });return{organizationId,property};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function actor(f:Fixture){
  const saved=await withTenant(db,f.organizationId,async tx=>{
    const person=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Actual native template author"}}),account=await tx.userAccount.create({data:{organizationId:f.organizationId,personId:person.id}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"template_"+randomUUID(),name:"Explicit template grants"}}),keys=["document:view","document:create","document:export","document_template:view","document_template:create","document_template:export","property:view","property:export","property_finance:view","property_finance:export","financial_transaction:view","financial_transaction:export"],permissions=await tx.permission.findMany({where:{organizationId:f.organizationId,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}))});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});return{account,person,assignment};
  });return{organizationId:f.organizationId,actorId:saved.account.id,authContext:{...await authContextForAccount(f.organizationId,saved.account.id,{db}),personId:saved.person.id},...saved};
}
const definition=()=>({schemaVersion:1,templateKey:"owner_agreement",locale:"fr" as const,title:"Convention {{property}}",variables:[{key:"property",kind:"TEXT"}],blocks:[{kind:"PARAGRAPH",text:"Texte original privé {{property}}. النص الأصلي"}]});
const draft=(f:Fixture)=>({documentId:null,source:{kind:"PROPERTY",id:f.property.id},typeKey:"typed_agreement",title:"Original authored agreement",supersedesId:null,effectiveFrom:null,definition:definition()});
async function admitted(f:Fixture,ctx:Awaited<ReturnType<typeof actor>>,input=draft(f)){
  const reviewed=await reviewDocumentTemplate(ctx,input,{db}),command={...input,idempotencyKey:randomUUID(),reviewFingerprint:reviewed.reviewFingerprint,reason:"Retain original authored template and nonce"},admission=await admitDocumentTemplate(ctx,command,{db,env});return{command,admission,bytes:encodeDocumentTemplate(input.definition)};
}
describe("native durable authored template admission",()=>{
  it("commits encrypted original content before I/O and completes after nonce-only recovery without any client file",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await admitted(f,ctx),row=await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:original.admission.id}}));
    expect(row.payloadCipher).not.toBeNull();expect(Buffer.from(row.payloadCipher!).includes(Buffer.from(original.bytes))).toBe(false);expect(JSON.stringify(row.input)).not.toContain("Texte original privé");expect(await recoverDocumentUpload(ctx,{idempotencyKey:original.command.idempotencyKey},{db})).toMatchObject({recorded:true,state:"ADMITTED"});
    const completed=await completeDocumentParts(ctx,{admissionId:row.id},{db,env,objects:store()});expect(completed.state).toBe("COMPLETE");expect(completed.version?.sha256).toBe(sha(original.bytes));expect(await completeDocumentParts(ctx,{admissionId:row.id},{db,env,objects:store()})).toEqual(completed);
    expect((await downloadDocumentVersion(ctx,{versionId:completed.version!.id},{db,objects:store()})).bytes).toEqual(Buffer.from(original.bytes));expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count())).toBe(1);
    expect((await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:row.id}}))).payloadCipher).toEqual(row.payloadCipher);
    const audits=await withTenant(db,f.organizationId,tx=>tx.auditLog.findMany({where:{resourceType:"document"}}));expect(JSON.stringify(audits)).not.toContain("Texte original privé");expect(JSON.stringify(audits)).not.toContain("payloadCipher");
  });
  it("retains the original financial source and first object ciphertext after a lost storage acknowledgement",async()=>{
    const f=await fixture(),ctx=await actor(f),journal=await withTenant(db,f.organizationId,async tx=>{const finance=new FinanceRepository(tx,f.organizationId),bank=await finance.ensureLedgerAccount({code:"TEMPLATE_BANK",name:"Original template source custody",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"TEMPLATE_OWNER",name:"Original template source ownership",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),amount=Money.of("9007199254740993.07","MAD"),dimensions={property_id:f.property.id};return finance.createFinancialTransaction({reference:"TEMPLATE:"+randomUUID(),description:"Original financial template evidence",idempotencyKey:randomUUID(),createdBy:ctx.actorId,occurredAt:await finance.clock(),postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"OWNER_REVENUE",dimensions},{ledgerAccountId:claim.id,side:"CREDIT",amount,bucket:"OWNER_REVENUE",dimensions}]});});
    const snapshot=()=>withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY id`),before=await snapshot(),original=await admitted(f,ctx,{...draft(f),source:{kind:"FINANCIAL_TRANSACTION",id:journal.id}});let lost=true,puts=0;
    const transport:typeof fetch=async(url,init)=>{const response=await fetch(url,init);if(init?.method==="PUT"){puts++;if(lost){lost=false;throw Error("Lost original template object acknowledgement");}}return response;};
    await expect(completeDocumentParts(ctx,{admissionId:original.admission.id},{db,env,objects:store(transport)})).rejects.toThrow("document_storage_unavailable");expect(puts).toBe(1);expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count())).toBe(0);
    const row=await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:original.admission.id}})),cipher=Buffer.from(objects.get("/"+row.storageKey)!);expect(cipher.length).toBeGreaterThan(0);
    const completed=await completeDocumentParts(ctx,{admissionId:row.id},{db,env,objects:store(transport)});expect(completed.state).toBe("COMPLETE");expect(puts).toBe(2);expect(objects.get("/"+row.storageKey)).toEqual(cipher);expect(await snapshot()).toEqual(before);
  });
  it("refuses changed definitions under the original nonce and keeps its original encrypted body",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await admitted(f,ctx),changed={...draft(f),definition:{...original.command.definition,title:"Different {{property}}"}},reviewed=await reviewDocumentTemplate(ctx,changed,{db});
    await expect(admitDocumentTemplate(ctx,{...changed,idempotencyKey:original.command.idempotencyKey,reason:original.command.reason,reviewFingerprint:reviewed.reviewFingerprint},{db,env})).rejects.toThrow("document_source_changed");expect(await recoverDocumentUpload(ctx,{idempotencyKey:original.command.idempotencyKey},{db})).toMatchObject({recorded:true,expected:{sha256:sha(original.bytes)}});expect(await withTenant(db,f.organizationId,tx=>tx.documentAdmission.count())).toBe(1);
  });
  it("denies a different actor, a real foreign tenant and revoked authority before object I/O",async()=>{
    const f=await fixture(),ctx=await actor(f),other=await actor(f),foreignFixture=await fixture(),foreign=await actor(foreignFixture),original=await admitted(f,ctx);let contacted=false;const transport:typeof fetch=(url,init)=>{contacted=true;return fetch(url,init);};
    for(const caller of [other,foreign])await expect(completeDocumentParts(caller,{admissionId:original.admission.id},{db,env,objects:store(transport)})).rejects.toThrow("document_unavailable");
    await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:ctx.assignment.id},data:{validTo:new Date("2020-01-02")}}));await expect(completeDocumentParts(ctx,{admissionId:original.admission.id},{db,env,objects:store(transport)})).rejects.toThrow("document_unavailable");expect(contacted).toBe(false);expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count())).toBe(0);
  });
  it("requires native encrypted payload and transport evidence and prevents rewriting the original body",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await admitted(f,ctx);
    await expect(withTenant(db,f.organizationId,tx=>tx.documentAdmission.update({where:{id:original.admission.id},data:{payloadCipher:Buffer.from("rewrite")}}))).rejects.toThrow("append-only");
    for(const change of ["missing-body","missing-budget"]){await expect(withTenant(db,f.organizationId,async tx=>{const row=await tx.documentAdmission.findUniqueOrThrow({where:{id:original.admission.id}}),id=randomUUID(),commandKey=randomUUID(),policy=JSON.parse(JSON.stringify(row.policySnapshot)) as {value:{upload_transport?:unknown}};if(change==="missing-budget")delete policy.value.upload_transport;return tx.documentAdmission.create({data:{...row,id,commandKey,storageKey:`organizations/${f.organizationId}/documents/${row.documentId}/admissions/${id}.encrypted`,input:{...prepareDocumentTemplate(draft(f)).metadata,idempotencyKey:commandKey,reviewFingerprint:original.command.reviewFingerprint,reason:row.reason},authorizationCap:json(row.authorizationCap),policySnapshot:policy as Prisma.InputJsonValue,...change==="missing-body"?{payloadCipher:null}:{}}});})).rejects.toThrow("document_template_payload_shape");}
    expect(await withTenant(db,f.organizationId,tx=>tx.documentAdmission.count())).toBe(1);
  });
  it("requires the native template kind and locale for a typed payload",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await admitted(f,ctx),bytes=Buffer.from("%PDF-1.7\n%%EOF"),metadata={documentId:null,source:{kind:"PROPERTY",id:f.property.id},typeKey:"typed_agreement",title:"Original ordinary file",kind:"FILE",locale:"fr",templateKey:null,fileName:"original.pdf",contentType:"application/pdf",fileSize:bytes.length,sha256:sha(bytes),supersedesId:null,effectiveFrom:null},reviewed=await reviewDocumentUpload(ctx,metadata,{db}),file=await admitDocumentUpload(ctx,{...metadata,idempotencyKey:randomUUID(),reviewFingerprint:reviewed.reviewFingerprint,reason:"Original ordinary file admission"},{db});
    await expect(withTenant(db,f.organizationId,async tx=>{const row=await tx.documentAdmission.findUniqueOrThrow({where:{id:original.admission.id}}),id=randomUUID(),commandKey=randomUUID(),input=JSON.parse(JSON.stringify(row.input)) as Prisma.InputJsonObject;return tx.documentAdmission.create({data:{...row,id,documentId:file.documentId,commandKey,storageKey:`organizations/${f.organizationId}/documents/${file.documentId}/admissions/${id}.encrypted`,input:{...input,kind:"FILE",templateKey:null,idempotencyKey:commandKey},authorizationCap:json(row.authorizationCap),policySnapshot:json(row.policySnapshot)}});})).rejects.toThrow("typed template payload requires its original native template and locale");
  });
  it("resumes with historical encryption keys while preserving the original durable ciphertext",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await admitted(f,ctx),row=await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:original.admission.id}})),next="template-rotated:"+randomBytes(32).toString("base64"),missing={...env,ENCRYPTION_KEYS:next};
    await expect(completeDocumentParts(ctx,{admissionId:row.id},{db,env:missing,objects:store(fetch,missing)})).rejects.toThrow("document_storage_unavailable");expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count())).toBe(0);
    const rotated={...env,ENCRYPTION_KEYS:next+","+env.ENCRYPTION_KEYS},completed=await completeDocumentParts(ctx,{admissionId:row.id},{db,env:rotated,objects:store(fetch,rotated)});expect(completed.state).toBe("COMPLETE");expect((await downloadDocumentVersion(ctx,{versionId:completed.version!.id},{db,objects:store(fetch,rotated)})).bytes).toEqual(Buffer.from(original.bytes));expect((await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:row.id}}))).payloadCipher).toEqual(row.payloadCipher);
  });
  it("spends the explicit completion budget across a provider failure without losing the original intent",async()=>{
    const f=await fixture(1),ctx=await actor(f),original=await admitted(f,ctx);let contacted=0;const transport:typeof fetch=()=>{contacted++;return Promise.resolve(new Response(null,{status:503}));};
    await expect(completeDocumentParts(ctx,{admissionId:original.admission.id},{db,env,objects:store(transport)})).rejects.toThrow("document_storage_unavailable");await expect(completeDocumentParts(ctx,{admissionId:original.admission.id},{db,env,objects:store(transport)})).rejects.toThrow("document_rate_limited");expect(contacted).toBe(1);expect(await recoverDocumentUpload(ctx,{idempotencyKey:original.command.idempotencyKey},{db})).toMatchObject({recorded:true,state:"ADMITTED"});expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count())).toBe(0);
  });
  it("captures the original definition before awaiting native admission rather than retaining mutable caller input",async()=>{
    const f=await fixture(),ctx=await actor(f),input=draft(f),reviewed=await reviewDocumentTemplate(ctx,input,{db}),expected=encodeDocumentTemplate(input.definition),command={...input,idempotencyKey:randomUUID(),reviewFingerprint:reviewed.reviewFingerprint,reason:"Retain original definition across admission wait"},pending=admitDocumentTemplate(ctx,command,{db,env});command.definition.blocks[0].text="Different caller text {{property}}";const admitted=await pending,row=await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findUniqueOrThrow({where:{id:admitted.id}}));
    expect(openDocumentTemplatePayload({organizationId:f.organizationId,documentId:row.documentId,admissionId:row.id,contentType:documentTemplateMediaType,fileSize:row.fileSize,sha256:row.sha256,templateKey:"owner_agreement",locale:"fr"},row.payloadCipher!,env)).toEqual(Buffer.from(expected));expect(row.sha256).toBe(sha(expected));
  });
});
