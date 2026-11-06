import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { DocumentRepository } from "@/modules/documents/infrastructure/document-repository";
import { documentArchivePolicyKey } from "@/modules/documents/domain/document-policy";
import { reviewDocumentUpload, admitDocumentUpload, recoverDocumentUpload, uploadDocumentBytes, readDocumentHistory, downloadDocumentVersion } from "@/modules/documents/application/document-archive";
import * as auditWriter from "@/platform/audit/audit-writer";
import { provisionIntegrationRole } from "./support/database-role";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { listAuditHistory, exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";

let admin: PrismaClient, db: PrismaClient, server: Server, storageUrl: string;
const objects = new Map<string, Buffer>(), encryption = { NODE_ENV: "test", ENCRYPTION_KEYS: "documents-native:" + randomBytes(32).toString("base64") };
const content = (title = "Original owner agreement") => Buffer.from("%PDF-1.7\n" + title + "\n%%EOF\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectStore = (transport: typeof fetch = fetch) => new DocumentObjectStore({ createSignedUploadUrl: ({ key }) => Promise.resolve({ url: storageUrl + "/" + key }),
  createSignedDownloadUrl: ({ key }) => Promise.resolve({ url: storageUrl + "/" + key }) }, transport, encryption);
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL; if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw Error("Owned local PostgreSQL required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  server = createServer((request, response) => { void (async () => {
    const key = request.url!;
    if (request.method === "PUT") { if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) response.writeHead(412).end(); else { objects.set(key, Buffer.concat(chunks)); response.writeHead(200).end(); } return; }
    const value = objects.get(key); if (value) response.writeHead(200, { "content-length": value.length }).end(value); else response.writeHead(404).end();
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned object transport required"); storageUrl = "http://127.0.0.1:" + address.port;
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

const policy = (privacy = ["operational"]) => ({ source: "NATIVE_DOCUMENT_ARCHIVE", encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY",
  types: [{ key: "agreement", labels: { en: "Agreement", fr: "Convention", ar: "اتفاقية" }, sources: ["PROPERTY", "ORGANIZATION"], privacy, content_types: ["application/pdf"], max_bytes: 1048576 }],
  upload_admission: { window_seconds: 3600, max_requests: 200 }, storage_url_seconds: 30 });
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated versioned archive acceptance", baseCurrency: "MAD" } }); await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated agreement villa", addressLine1: "Owned acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    await new ConfigRuleRepository(tx, org).createVersion({ key: documentArchivePolicyKey, scopeType: "organization", value: policy(), effectiveFrom: new Date("2020-01-01"), reason: "Explicit document classification and upload policy" }); return { org, property };
  }); return source;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Fixture, keys = ["document:view","document:create","document:export","document_template:view","document_template:create","document_template:export","property:view","property:export","organization:view","organization:export","property_finance:view","property_finance:export"], propertyOnly = false, cap?: string) {
  const identity = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Dedicated archive actor" } }), account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } }), role = await tx.role.create({ data: { organizationId: f.org, key: "archive_" + randomUUID(), name: "Explicit document grants" } });
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    const assignment = await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: propertyOnly ? "property" : "organization", scopeId: propertyOnly ? f.property.id : null, validFrom: new Date("2020-01-01"), ...(cap ? { conditions: { maxAmount: cap } } : {}) } });
    return { account, person, assignment, role };
  }); return { organizationId: f.org, actorId: identity.account.id, personId: identity.person.id, authContext: { ...await authContextForAccount(f.org,identity.account.id,{db}), personId: identity.person.id }, ...identity };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const input = (f: Fixture, bytes = content(), overrides = {}) => ({ documentId: null, source: { kind: "PROPERTY", id: f.property.id }, typeKey: "agreement", kind: "FILE", locale: "fr", title: "Convention propriétaire", fileName: "اتفاقية-original.pdf",
  contentType: "application/pdf", fileSize: bytes.length, sha256: hash(bytes), supersedesId: null, effectiveFrom: null, templateKey: null, ...overrides });
async function admit(f: Fixture, ctx: Actor, bytes = content(), overrides = {}, nonce = randomUUID()) {
  const metadata = input(f,bytes,overrides), reviewed = await reviewDocumentUpload(ctx,metadata,{db}), command = { ...metadata, idempotencyKey: nonce, reviewFingerprint: reviewed.reviewFingerprint, reason: "Retain the exact original document and provenance" };
  return { admission: await admitDocumentUpload(ctx,command,{db}), command };
}
async function uploaded(f: Fixture, ctx: Actor, bytes = content(), overrides = {}) { const prepared = await admit(f,ctx,bytes,overrides), completed = await uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},bytes,{db,objects:objectStore()}); if (!completed.version) throw Error("Completed archive version required"); return { ...prepared, ...completed, version: completed.version }; }
const revoke = (f: Fixture, ctx: Actor) => withTenant(db,f.org,tx => tx.roleAssignment.update({ where: { id: ctx.assignment.id }, data: { validTo: new Date("2020-01-02") } }));

describe("native private document archive", () => {
  it("durably recovers a lost admission response and appends only one encrypted original version", async () => {
    const f = await fixture(), ctx = await actor(f), prepared = await admit(f,ctx);
    expect(await recoverDocumentUpload(ctx,{idempotencyKey:prepared.command.idempotencyKey},{db})).toEqual(prepared.admission);
    expect(await admitDocumentUpload(ctx,prepared.command,{db})).toEqual(prepared.admission);
    expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(0);
    const completed = await uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},content(),{db,objects:objectStore()}); expect(completed.complete).toBe(true); expect(completed.version?.number).toBe(1);
    expect(await recoverDocumentUpload(ctx,{idempotencyKey:prepared.command.idempotencyKey},{db})).toEqual(completed);
    expect(await withTenant(db,f.org,tx=>tx.documentAdmission.count())).toBe(1); expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(1);
    const history = await readDocumentHistory(ctx,{documentId:completed.documentId},{db}); expect(history.versions).toEqual([completed.version]); expect(history.document.locale).toBe("fr");
    expect((await downloadDocumentVersion(ctx,{versionId:completed.version!.id},{db,objects:objectStore()})).bytes).toEqual(content());
    expect([...objects.values()].some(value=>value.includes(content()))).toBe(false);
    const audits = await withTenant(db,f.org,tx=>tx.auditLog.findMany({where:{resourceType:"document"}})); expect(JSON.stringify(audits)).not.toContain("Convention propriétaire"); expect(JSON.stringify(audits)).not.toContain(prepared.command.reason);
  });
  it("does not retry a lost object acknowledgement and reuses its immutable ciphertext on explicit recovery", async () => {
    const f = await fixture(), ctx = await actor(f), prepared = await admit(f,ctx); let calls = 0;
    const transport: typeof fetch = async (url,init)=>{const response=await fetch(url,init); if(init?.method==="PUT"&&++calls===1)throw Error("lost owned PUT acknowledgement");return response;};
    await expect(uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},content(),{db,objects:objectStore(transport)})).rejects.toThrow("document_storage_unavailable"); expect(calls).toBe(1);
    const retained = [...objects.values()].map(value=>Buffer.from(value)); const completed = await uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},content(),{db,objects:objectStore(transport)});
    expect(calls).toBe(2); expect([...objects.values()]).toEqual(retained); expect(completed.version?.number).toBe(1); expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(1);
  });
  it("retains original file bodies and tuple versions when an amendment supersedes version one", async () => {
    const f = await fixture(), ctx = await actor(f), original = await uploaded(f,ctx), retained = await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT to_jsonb(v) AS body,xmin::text FROM document_version v WHERE organization_id=${f.org}::uuid`);
    const amendment = await uploaded(f,ctx,content("Amendment version two"),{documentId:original.documentId,supersedesId:original.version.id,title:"Avenant conservé"}); expect(amendment.version.number).toBe(2);
    expect(await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT to_jsonb(v) AS body,xmin::text FROM document_version v WHERE organization_id=${f.org}::uuid AND id=${original.version.id}::uuid`)).toEqual(retained);
    const history = await readDocumentHistory(ctx,{documentId:original.documentId},{db}); expect(history.versions.map(version=>version.number)).toEqual([2,1]); expect(history.versions[1].supersededById).toBe(amendment.version.id);
    expect((await downloadDocumentVersion(ctx,{versionId:original.version.id},{db,objects:objectStore()})).bytes).toEqual(content()); expect((await downloadDocumentVersion(ctx,{versionId:amendment.version.id},{db,objects:objectStore()})).bytes).toEqual(content("Amendment version two"));
  });
  it("serializes concurrent amendments and preserves the losing admission without a branched history", async () => {
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx),a=await admit(f,ctx,content("Concurrent A"),{documentId:original.documentId,supersedesId:original.version.id}),b=await admit(f,ctx,content("Concurrent B"),{documentId:original.documentId,supersedesId:original.version.id});
    const results=await Promise.allSettled([uploadDocumentBytes(ctx,{admissionId:a.admission.id},content("Concurrent A"),{db,objects:objectStore()}),uploadDocumentBytes(ctx,{admissionId:b.admission.id},content("Concurrent B"),{db,objects:objectStore()})]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);expect(await withTenant(db,f.org,tx=>tx.documentAdmission.count())).toBe(3);expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(2);
  });
  it("rejects nonce substitution, another actor's recovery and foreign-tenant document reads",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx),other=await actor(f),foreign=await fixture(),foreignActor=await actor(foreign);
    await expect(admitDocumentUpload(ctx,{...original.command,reason:"Substituted original document reason"},{db})).rejects.toThrow("document_source_changed");
    await expect(recoverDocumentUpload(other,{idempotencyKey:original.command.idempotencyKey},{db})).rejects.toThrow("document_unavailable");
    await expect(readDocumentHistory(foreignActor,{documentId:original.documentId},{db})).rejects.toThrow("document_unavailable");
    expect(await withTenant(db,foreign.org,tx=>tx.document.findMany())).toEqual([]);expect(await withTenant(db,foreign.org,tx=>tx.documentVersion.findMany())).toEqual([]);
  });
  it("requires independent document grants in addition to operational property access",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx),operations=await actor(f,["property:view","property:export"]);
    await expect(readDocumentHistory(operations,{documentId:original.documentId},{db})).rejects.toThrow("document_unavailable");
    await expect(reviewDocumentUpload(operations,input(f),{db})).rejects.toThrow("document_unavailable");
  });
  it("rolls version admission back when current authority is revoked after object transport",async()=>{
    const f=await fixture(),ctx=await actor(f),prepared=await admit(f,ctx);let changed=false;
    const transport:typeof fetch=async(url,init)=>{const response=await fetch(url,init);if(!changed&&init?.method==="PUT"){changed=true;await revoke(f,ctx);}return response;};
    await expect(uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},content(),{db,objects:objectStore(transport)})).rejects.toThrow("document_unavailable");
    expect(changed).toBe(true);expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(0);expect(await withTenant(db,f.org,tx=>tx.documentAdmission.count())).toBe(1);
  });
  it("rechecks authority after the actual final append audit and retains its durable original admission",async()=>{
    const f=await fixture(),ctx=await actor(f),prepared=await admit(f,ctx),original=auditWriter.writeAuditEvent;let changed=false;
    const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await original(tx,event);if(!changed&&event.action==="documents.version_added"){changed=true;await revoke(f,ctx);}return result;});
    try{await expect(uploadDocumentBytes(ctx,{admissionId:prepared.admission.id},content(),{db,objects:objectStore()})).rejects.toThrow("document_unavailable");}finally{spy.mockRestore();}
    expect(changed).toBe(true);expect(await withTenant(db,f.org,tx=>tx.documentVersion.count())).toBe(0);expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"documents.version_added"}}))).toBe(0);
  });
  it("retains completed versions and recovers their original nonce after a later classification policy is replaced",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx);
    await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:documentArchivePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{...policy(),types:[{...policy().types[0],key:"new_agreement"}]},reason:"Explicit new classification without rewriting original versions"}));
    expect((await recoverDocumentUpload(ctx,{idempotencyKey:original.command.idempotencyKey},{db})).version?.id).toBe(original.version.id);expect((await readDocumentHistory(ctx,{documentId:original.documentId},{db})).versions[0].id).toBe(original.version.id);
    expect((await downloadDocumentVersion(ctx,{versionId:original.version.id},{db,objects:objectStore()})).bytes).toEqual(content());
  });
  it("rejects native history rewrites, hard deletion, changed sources and unaudited document creation",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx);
    await expect(withTenant(db,f.org,tx=>tx.documentVersion.update({where:{id:original.version.id},data:{title:"Rewrite original"}}))).rejects.toThrow("append-only");
    await expect(withTenant(db,f.org,tx=>tx.documentAdmission.update({where:{id:original.admission.id},data:{reason:"Rewrite original provenance"}}))).rejects.toThrow("append-only");
    await expect(withTenant(db,f.org,tx=>tx.document.delete({where:{id:original.documentId}}))).rejects.toThrow("hard-deleted");
    await expect(withTenant(db,f.org,tx=>tx.document.update({where:{id:original.documentId},data:{sourceKind:"ORGANIZATION",sourceId:f.org,propertyId:null}}))).rejects.toThrow("cannot be rewritten");
    await expect(withTenant(db,f.org,async tx=>{const source=await new DocumentRepository(tx,f.org).document(original.documentId);if(!source)throw Error("Original source required");const{id,template,instance,...copy}=source;if(id!==original.documentId||template||instance)throw Error("Original file identity required");return tx.document.create({data:{...copy,id:randomUUID(),commandKey:randomUUID()}});})).rejects.toThrow("atomic private history");
    expect((await readDocumentHistory(ctx,{documentId:original.documentId},{db})).versions[0].title).toBe("Convention propriétaire");
  });
  it("archives a template as a separate native document identity without inventing a signed instance",async()=>{
    const f=await fixture(),ctx=await actor(f),template=await uploaded(f,ctx,content("Agreement template"),{source:{kind:"ORGANIZATION",id:f.org},kind:"TEMPLATE",templateKey:"owner_agreement"});
    const root=await withTenant(db,f.org,tx=>new DocumentRepository(tx,f.org).document(template.documentId));expect(root?.template).toMatchObject({key:"owner_agreement",locale:"fr"});expect(root?.instance).toBe(null);
    expect(await withTenant(db,f.org,tx=>tx.signature.count())).toBe(0);expect(await withTenant(db,f.org,tx=>tx.documentInstance.count())).toBe(0);
  });
  it("requires original financial journal authority with exact amount limits and leaves every Money row unchanged",async()=>{
    const f=await fixture(),keys=["document:view","document:create","document:export","financial_transaction:view","financial_transaction:export"],ctx=await actor(f,keys,true),limited=await actor(f,keys,true,"9007199254740993.06"),operational=await actor(f,["document:view","document:create","document:export","property:view"],true);
    const source=await withTenant(db,f.org,async tx=>{
      await tx.currency.upsert({where:{code:"MAD"},update:{},create:{code:"MAD",name:"MAD",minorUnit:2}});
      const finance=new FinanceRepository(tx,f.org),bank=await finance.ensureLedgerAccount({code:"ARCHIVE_BANK",name:"Dedicated archive source bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"ARCHIVE_OWNER",name:"Dedicated archive owner claim",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
      const journal=await finance.createFinancialTransaction({reference:"ARCHIVE:"+randomUUID(),description:"Actual original native archive journal",idempotencyKey:randomUUID(),createdBy:ctx.actorId,occurredAt:await finance.clock(),postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount:Money.of("9007199254740993.07","MAD"),bucket:"OWNER_REVENUE",dimensions:{property_id:f.property.id}},{ledgerAccountId:claim.id,side:"CREDIT",amount:Money.of("9007199254740993.07","MAD"),bucket:"OWNER_REVENUE",dimensions:{property_id:f.property.id}}]});
      const configured=policy(["financial"]);await new ConfigRuleRepository(tx,f.org).createVersion({key:documentArchivePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{...configured,types:[{...configured.types[0],sources:["FINANCIAL_TRANSACTION"]}]},createdBy:ctx.actorId,reason:"Explicit financial native-journal archive classification"});return journal;
    });
    const retained=await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT 'journal' AS kind,to_jsonb(t) AS body,xmin::text FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',to_jsonb(p),xmin::text FROM posting p WHERE organization_id=${f.org}::uuid ORDER BY kind,body`);
    const metadata={source:{kind:"FINANCIAL_TRANSACTION",id:source.id}};await expect(reviewDocumentUpload(limited,input(f,content(),metadata),{db})).rejects.toThrow("document_unavailable");await expect(reviewDocumentUpload(operational,input(f,content(),metadata),{db})).rejects.toThrow("document_unavailable");
    const original=await uploaded(f,ctx,content(),metadata);expect((await readDocumentHistory(ctx,{documentId:original.documentId},{db})).document.privacy).toContain("financial");
    expect((await downloadDocumentVersion(ctx,{versionId:original.version.id},{db,objects:objectStore()})).bytes).toEqual(content());await expect(readDocumentHistory(limited,{documentId:original.documentId},{db})).rejects.toThrow("document_unavailable");
    expect(await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT 'journal' AS kind,to_jsonb(t) AS body,xmin::text FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',to_jsonb(p),xmin::text FROM posting p WHERE organization_id=${f.org}::uuid ORDER BY kind,body`)).toEqual(retained);
  });
  it("adds financial protection across all retained versions and never removes it on a later policy downgrade",async()=>{
    const f=await fixture(),ctx=await actor(f),reader=await actor(f,["document:view","property:view"],true),original=await uploaded(f,ctx);
    expect((await readDocumentHistory(reader,{documentId:original.documentId},{db})).versions).toHaveLength(1);
    await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:documentArchivePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:policy(["financial"]),reason:"Protect the actual document as financial material"}));
    await expect(readDocumentHistory(reader,{documentId:original.documentId},{db})).rejects.toThrow("document_unavailable");
    const amendment=await uploaded(f,ctx,content("Protected amendment"),{documentId:original.documentId,supersedesId:original.version.id});
    expect((await readDocumentHistory(ctx,{documentId:original.documentId},{db})).document.privacy).toEqual(["financial","operational"]);
    await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:documentArchivePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:policy(),reason:"Later operational default cannot rewrite original protection"}));
    await expect(readDocumentHistory(reader,{documentId:original.documentId},{db})).rejects.toThrow("document_unavailable");
    expect((await readDocumentHistory(ctx,{documentId:original.documentId},{db})).versions.map(version=>version.id)).toEqual([amendment.version.id,original.version.id]);
  });
  it.each(["documents.history_read","documents.version_downloaded"])("rechecks current disclosure after the actual %s audit",async action=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx),write=auditWriter.writeAuditEvent;let changed=false;
    const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await write(tx,event);if(!changed&&event.action===action){changed=true;await revoke(f,ctx);}return result;});
    try{await expect(action.endsWith("history_read")?readDocumentHistory(ctx,{documentId:original.documentId},{db}):downloadDocumentVersion(ctx,{versionId:original.version.id},{db,objects:objectStore()})).rejects.toThrow("document_unavailable");}finally{spy.mockRestore();}expect(changed).toBe(true);
    expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action}}))).toBe(0);
  });
  it("retains private business reasons outside generic audit disclosure and CSV export",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx),auditor=await actor(f,["audit_log:view","audit_log:export"]);
    const history=await listAuditHistory(auditor,{resourceType:"document"},{db}),csv=await exportAuditHistoryCsv(auditor,{resourceType:"document"},{db});
    for(const disclosed of [JSON.stringify(history),csv]){expect(disclosed).not.toContain(original.command.title);expect(disclosed).not.toContain(original.command.fileName);expect(disclosed).not.toContain(original.command.reason);expect(disclosed).not.toContain("ENCRYPTION_KEYS");}
    const actions=await withTenant(db,f.org,tx=>tx.documentAction.findMany());expect(actions.map(action=>action.reason)).toContain(original.command.reason);
  });
  it("enforces all nine forced tenant policies and null-safe native source identity",async()=>{
    const f=await fixture(),ctx=await actor(f),original=await uploaded(f,ctx);
    const tables=["document","document_admission","document_version","document_template","document_instance","signature","signature_recipient","signature_event","document_action"];
    const policies=await admin.$queryRaw<{relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean}[]>`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[])`;
    expect(policies).toHaveLength(9);expect(policies.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);expect(await db.document.count()).toBe(0);expect(await db.documentVersion.count()).toBe(0);
    await expect(withTenant(db,f.org,async tx=>{const source=await new DocumentRepository(tx,f.org).document(original.documentId);if(!source)throw Error("Original source required");const{id,template,instance,...copy}=source;if(id!==original.documentId||template||instance)throw Error("Original file identity required");return tx.document.create({data:{...copy,id:randomUUID(),commandKey:randomUUID(),propertyId:null,personId:ctx.person.id}});})).rejects.toThrow("document_source_shape");
  });
});
