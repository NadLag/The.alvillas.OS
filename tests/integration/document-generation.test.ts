import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { formatCurrency } from "@/i18n/format";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { reviewDocumentTemplate, admitDocumentTemplate } from "@/modules/documents/application/document-template-authoring";
import { completeDocumentParts, recoverDocumentUpload, appendDocumentHistory, documentArchiveContext, documentJson } from "@/modules/documents/application/document-archive";
import { DocumentRepository } from "@/modules/documents/infrastructure/document-repository";
import { encryptBytes } from "@/platform/auth/secret-encryption";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { reviewDocumentGeneration } from "@/modules/documents/application/document-generation-review";
import { admitDocumentGeneration, recoverDocumentGeneration, documentGenerationOutboxKey } from "@/modules/documents/application/document-generation-admission";
import { documentGenerationSnapshotSchema, documentGenerationRequested } from "@/modules/documents/domain/document-generation";
import { documentTemplateMediaType } from "@/modules/documents/domain/document-template-format";
import { openDocumentGenerationInput } from "@/modules/documents/infrastructure/document-generation-payload";
import { provisionIntegrationRole } from "./support/database-role";
import * as auditWriter from "@/platform/audit/audit-writer";
import { publishDocumentGeneration } from "@/modules/documents/application/document-generation-publication";
import { downloadDocumentVersion } from "@/modules/documents/application/document-archive";
import { DocumentPdfRenderer } from "@/modules/documents/infrastructure/document-pdf-renderer";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { executeDocumentGenerationReference, failDocumentGenerationReference } from "@/modules/documents/application/document-generation-worker";
import { readDocumentSourceWorkspace } from "@/modules/documents/application/document-workspace";
import type { Prisma } from "@prisma/client";

let admin: PrismaClient, db: PrismaClient, server: Server, base: string, puts = 0;
const objects = new Map<string, Buffer>(), env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "native-generation:" + randomBytes(32).toString("base64") };
const store = (transport: typeof fetch = fetch) => new DocumentObjectStore({ createSignedUploadUrl: ({ key }) => Promise.resolve({ url: base + "/" + key }), createSignedDownloadUrl: ({ key }) => Promise.resolve({ url: base + "/" + key }) }, transport, env);
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL; if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw Error("Owned native PostgreSQL required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests"); const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  server = createServer((request, response) => { void (async () => {
    const key = request.url!; if (request.method === "PUT") { puts++; if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; } const chunks: Buffer[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk)); if (objects.has(key)) response.writeHead(412).end(); else { objects.set(key, Buffer.concat(chunks)); response.writeHead(200).end(); } }
    else { const value = objects.get(key); if (value) response.writeHead(200, { "content-length": value.length }).end(value); else response.writeHead(404).end(); }
  })().catch(() => response.destroy()); }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned object transport required"); base = "http://127.0.0.1:" + address.port;
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(financial = false, selectedLocale: "en" | "fr" = "fr", amendments = false) {
  const organizationId = randomUUID(); await admin.organization.create({ data: { id: organizationId, name: "Actual native generation acceptance", baseCurrency: "MAD" } }); await ensureStandardIdentitySetup(organizationId, { db });
  const saved = await withTenant(db, organizationId, async tx => {
    const property = await tx.property.create({ data: { organizationId, name: "Actual original generated villa", addressLine1: "Original entered address", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } }), person = await tx.person.create({ data: { organizationId, displayName: "Actual native generator" } }), account = await tx.userAccount.create({ data: { organizationId, personId: person.id } }), role = await tx.role.create({ data: { organizationId, key: "generation_" + randomUUID(), name: "Explicit generation source grants" } }), keys = ["document:view", "document:create", "document:export", "document_template:view", "document_template:create", "document_template:export", "document_instance:view", "document_instance:create", "document_instance:export", "property:view", "property:export", "property_finance:view", "property_finance:export", "financial_transaction:view", "financial_transaction:export"], permissions = await tx.permission.findMany({ where: { organizationId, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    if (amendments) permissions.push(...await tx.permission.findMany({ where: { organizationId, key: { in: ["document:edit", "document_template:edit"] } } }));
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId, roleId: role.id, permissionId: permission.id })) }); const assignment = await tx.roleAssignment.create({ data: { organizationId, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
    await new ConfigRuleRepository(tx, organizationId).createVersion({ key: "documents.archive", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Explicit actual native generation policy", value: { source: "NATIVE_DOCUMENT_ARCHIVE", encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY", storage_url_seconds: 30, upload_admission: { window_seconds: 3600, max_requests: 100 }, upload_transport: { window_seconds: 3600, max_requests: 100 }, types: [{ key: "generated_agreement", labels: { en: "Generated agreement", fr: "Convention générée", ar: "اتفاقية منشأة" }, sources: ["PROPERTY", "FINANCIAL_TRANSACTION"], privacy: ["financial"], content_types: ["application/pdf", documentTemplateMediaType], max_bytes: 1048576 }] } }); return { property, person, account, assignment };
  });
  const ctx = { organizationId, actorId: saved.account.id, authContext: { ...await authContextForAccount(organizationId, saved.account.id, { db }), personId: saved.person.id } }, reference = "GENERATION:" + randomUUID(), journal = financial ? await withTenant(db, organizationId, async tx => {
    const finance = new FinanceRepository(tx, organizationId), bank = await finance.ensureLedgerAccount({ code: "GENERATION_BANK", name: "Actual original custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }), claim = await finance.ensureLedgerAccount({ code: "GENERATION_OWNER", name: "Actual original ownership", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }), amount = Money.of("9007199254740993.07", "MAD"), dimensions = { property_id: saved.property.id };
    return finance.createFinancialTransaction({ reference, description: "Actual original generation financial evidence", idempotencyKey: randomUUID(), createdBy: ctx.actorId, occurredAt: await finance.clock(), postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount, bucket: "OWNER_REVENUE", dimensions }] });
  }) : null, marker = "PRIVATE-TEMPLATE-" + randomUUID(), templates = [];
  for (const locale of ["en", "fr"] as const) {
    const definition = { schemaVersion: 1, templateKey: "actual_agreement", locale, title: (locale === "en" ? "Agreement " : "Convention ") + (financial ? "{{transaction_reference}}" : "{{property}}"), variables: financial ? [{ key: "transaction_reference", kind: "TEXT" }, { key: "transaction_amount", kind: "MONEY" }] : [{ key: "property", kind: "TEXT" }], blocks: [{ kind: "PARAGRAPH", text: marker + (financial ? " {{transaction_amount}}" : " {{property}}") }] }, draft = { documentId: null, source: { kind: "PROPERTY", id: saved.property.id }, typeKey: "generated_agreement", title: "Original " + locale + " definition", supersedesId: null, effectiveFrom: null, definition }, review = await reviewDocumentTemplate(ctx, draft, { db }), command = { ...draft, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint, reason: "Retain actual authored native language original" }, admission = await admitDocumentTemplate(ctx, command, { db, env }), completed = await completeDocumentParts(ctx, { admissionId: admission.id }, { db, env, objects: store() }); templates.push({ command, versionId: completed.version!.id });
  }
  const draft = { templateVersionId: templates[selectedLocale === "en" ? 0 : 1].versionId, variantVersionIds: templates.map(template => template.versionId), source: journal ? { kind: "FINANCIAL_TRANSACTION", id: journal.id } : { kind: "PROPERTY", id: saved.property.id }, title: "Actual generated archive caption", effectiveFrom: null }, review = await reviewDocumentGeneration(ctx, draft, { db, env }), command = { ...draft, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint, reason: "Generate from the retained actual native source" };
  return { organizationId, ctx, ...saved, journal, marker, templates, draft, command };
}
const money = (organizationId: string) => withTenant(db, organizationId, tx => tx.$queryRaw`SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE organization_id=${organizationId}::uuid UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE organization_id=${organizationId}::uuid ORDER BY id`);
async function amendedTemplates(f: Awaited<ReturnType<typeof fixture>>) {
  const ids: string[] = [];
  for (const original of f.templates) {
    const version = await withTenant(db, f.organizationId, tx => tx.documentVersion.findUniqueOrThrow({ where: { id: original.versionId } }));
    const reviewDraft = { source: original.command.source, typeKey: original.command.typeKey, title: original.command.title, effectiveFrom: original.command.effectiveFrom,
      documentId: version.documentId, supersedesId: version.id, definition: { ...original.command.definition,
      blocks: [{ kind: "PARAGRAPH", text: f.marker + " AMENDED " + (f.journal ? "{{transaction_amount}}" : "{{property}}") }] } };
    const review = await reviewDocumentTemplate(f.ctx, reviewDraft, { db }), receipt = await admitDocumentTemplate(f.ctx, { ...reviewDraft, idempotencyKey: randomUUID(),
      reviewFingerprint: review.reviewFingerprint, reason: "Retain the actual revised authored language original" }, { db, env });
    const complete = await completeDocumentParts(f.ctx, { admissionId: receipt.id }, { db, env, objects: store() }); ids.push(complete.version!.id);
  }
  return ids;
}
async function amendmentCommand(f: Awaited<ReturnType<typeof fixture>>, original: { documentId: string; versionId: string | null }, ids: string[]) {
  if (!original.versionId) throw Error("The actual original must be published before its amendment");
  const draft = { ...f.draft, documentId: original.documentId, supersedesId: original.versionId, templateVersionId: ids[1], variantVersionIds: ids },
    review = await reviewDocumentGeneration(f.ctx, draft, { db, env });
  return { ...draft, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint, reason: "Append an actual generated amendment without changing its original" };
}
const lineage = (organizationId: string, documentId: string) => withTenant(db, organizationId, tx => tx.$queryRaw<Array<{ id: string; xmin: string; body: string }>>`
  SELECT i.id::text,i.xmin::text,md5(to_jsonb(i)::text) AS body FROM document_instance i WHERE i.document_id=${documentId}::uuid
  UNION ALL SELECT v.id::text,v.xmin::text,md5(to_jsonb(v)::text) FROM document_version v WHERE v.document_id=${documentId}::uuid
  UNION ALL SELECT a.id::text,a.xmin::text,md5(to_jsonb(a)::text) FROM document_admission a WHERE a.document_id=${documentId}::uuid ORDER BY id`);
describe("immutable generated amendments", () => {
  it("retains a native draft signature on its original instance and rejects substitution of the amendment version", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() });
    const signature = await withTenant(db, f.organizationId, async tx => {
      const repository = new DocumentRepository(tx, f.organizationId), instance = await repository.instance(first.id); if (!instance) throw Error("Actual original required");
      const snapshot = documentGenerationSnapshotSchema.parse(instance.sourceSnapshot), current = await documentArchiveContext(f.ctx, tx, f.draft.source, "view", instance.document),
        commandKey = randomUUID(), commandHash = commandFingerprint({ instanceId: first.id, versionId: original.versionId, commandKey }),
        row = await tx.signature.create({ data: { organizationId: f.organizationId, instanceId: first.id, documentVersionId: original.versionId!,
          policySnapshot: documentJson(snapshot.policySnapshot), authorizationCap: documentJson(snapshot.authorizationCap), sourceFingerprint: current.native.fingerprint,
          commandKey, commandHash, reason: "Native draft lineage guard acceptance without any provider outcome", requestedBy: f.ctx.actorId, requestedAt: current.now } });
      await tx.signatureRecipient.create({ data: { organizationId: f.organizationId, signatureId: row.id, personId: f.person.id,
        identityHash: commandFingerprint({ organizationId: f.organizationId, personId: f.person.id }),
        emailCipher: new Uint8Array(encryptBytes(Buffer.from("actual-recipient@example.test"), "native-draft-recipient:" + row.id, env)), sourceSnapshot: { personId: f.person.id } } });
      await tx.signatureEvent.create({ data: { organizationId: f.organizationId, signatureId: row.id, state: "DRAFT", evidenceHash: commandHash, occurredAt: current.now, observedAt: current.now } });
      await appendDocumentHistory(f.ctx, tx, current, original.documentId, "SIGNATURE_CREATED", commandKey, commandHash, row.reason, {}, { signatureId: row.id }, { db, env });
      return row;
    }), retained = () => withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT s.id::text,s.xmin::text,md5(to_jsonb(s)::text) AS body FROM signature s WHERE s.id=${signature.id}::uuid
      UNION ALL SELECT e.id::text,e.xmin::text,md5(to_jsonb(e)::text) FROM signature_event e WHERE e.signature_id=${signature.id}::uuid
      UNION ALL SELECT r.id::text,r.xmin::text,md5(to_jsonb(r)::text) FROM signature_recipient r WHERE r.signature_id=${signature.id}::uuid ORDER BY id`), before = await retained(),
      command = await amendmentCommand(f, original, await amendedTemplates(f)), intent = await admitDocumentGeneration(f.ctx, command, { db, env }),
      complete = await publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects: store() });
    expect(await retained()).toEqual(before);
    await expect(withTenant(db, f.organizationId, tx => tx.signature.create({ data: { ...signature, policySnapshot: documentJson(signature.policySnapshot), authorizationCap: documentJson(signature.authorizationCap), id: randomUUID(), commandKey: randomUUID(), documentVersionId: complete.versionId! } })))
      .rejects.toThrow("signature requires original instance");
    await expect(withTenant(db, f.organizationId, tx => tx.signatureEvent.create({ data: { organizationId: f.organizationId, signatureId: signature.id,
      state: "DRAFT", evidenceHash: commandFingerprint({ attempt: randomUUID() }), signedVersionId: complete.versionId, occurredAt: signature.requestedAt } })))
      .rejects.toThrow("signature evidence cannot switch");
    expect(await retained()).toEqual(before);
  });
  it("keeps the logical root creator while admitting an amendment by a different currently authorized account", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), ids = await amendedTemplates(f);
    const second = await withTenant(db, f.organizationId, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.organizationId, displayName: "Actual authorized amendment author" } }),
        account = await tx.userAccount.create({ data: { organizationId: f.organizationId, personId: person.id } });
      await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: account.id, personId: person.id, roleId: f.assignment.roleId,
        scopeType: "organization", validFrom: new Date("2020-01-01") } }); return { person, account };
    }), ctx = { organizationId: f.organizationId, actorId: second.account.id, authContext: { ...await authContextForAccount(f.organizationId, second.account.id, { db }), personId: second.person.id } },
      command = await amendmentCommand({ ...f, ctx }, original, ids), intent = await admitDocumentGeneration(ctx, command, { db, env }),
      complete = await publishDocumentGeneration(ctx, { instanceId: intent.id }, { db, env, objects: store() });
    expect(complete.state).toBe("COMPLETE");
    expect(await withTenant(db, f.organizationId, tx => tx.document.findUniqueOrThrow({ where: { id: original.documentId } }))).toMatchObject({ createdBy: f.ctx.actorId });
    expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: intent.id } }))).toMatchObject({ createdBy: ctx.actorId });
    await expect(recoverDocumentGeneration(f.ctx, { idempotencyKey: command.idempotencyKey }, { db, env })).rejects.toThrow("document_unavailable");
    expect(await recoverDocumentGeneration(ctx, { idempotencyKey: command.idempotencyKey }, { db, env })).toEqual(complete);
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(original);
  });
  it("rejects a different template family, changed source, foreign tenant and stale predecessor", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), ids = await amendedTemplates(f),
      command = await amendmentCommand(f, original, ids), draft = { ...f.draft, documentId: original.documentId, supersedesId: original.versionId, templateVersionId: ids[1], variantVersionIds: ids },
      foreign = await fixture(false, "fr", true);
    await expect(reviewDocumentGeneration(foreign.ctx, draft, { db, env })).rejects.toThrow("document_unavailable");
    const other = await withTenant(db, f.organizationId, tx => tx.property.create({ data: { organizationId: f.organizationId, name: "Different actual source", addressLine1: "Other entered address",
      city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } }));
    await expect(reviewDocumentGeneration(f.ctx, { ...draft, source: { kind: "PROPERTY", id: other.id } }, { db, env })).rejects.toThrow("document_source_changed");
    const familyIds: string[] = [];
    for (const template of f.templates) {
      const authored = { documentId: null, supersedesId: null, source: template.command.source, typeKey: template.command.typeKey, title: template.command.title,
        effectiveFrom: null, definition: { ...template.command.definition, templateKey: "different_native_agreement" } }, review = await reviewDocumentTemplate(f.ctx, authored, { db }),
        admitted = await admitDocumentTemplate(f.ctx, { ...authored, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint, reason: "Retain a different actual template family" }, { db, env }),
        complete = await completeDocumentParts(f.ctx, { admissionId: admitted.id }, { db, env, objects: store() }); familyIds.push(complete.version!.id);
    }
    await expect(reviewDocumentGeneration(f.ctx, { ...draft, templateVersionId: familyIds[1], variantVersionIds: familyIds }, { db, env })).rejects.toThrow("document_source_changed");
    const intent = await admitDocumentGeneration(f.ctx, command, { db, env }); await publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects: store() });
    await expect(admitDocumentGeneration(f.ctx, { ...command, idempotencyKey: randomUUID() }, { db, env })).rejects.toThrow("document_source_changed");
    expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.count())).toBe(2);
  });
  it.each([false, true])("appends an actual amendment while preserving the original intent, PDF, nonce and financial tuple versions (financial=%s)", async financial => {
    const f = await fixture(financial, "fr", true), originalIntent = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: originalIntent.id }, { db, env, objects: store() }), oldRows = await lineage(f.organizationId, original.documentId),
      oldMoney = await money(f.organizationId), originalFile = await downloadDocumentVersion(f.ctx, { versionId: original.versionId }, { db, env, objects: store() });
    if (!financial) await withTenant(db, f.organizationId, tx => tx.property.update({ where: { id: f.property.id }, data: { name: "Actual revised villa name" } }));
    const ids = await amendedTemplates(f), command = await amendmentCommand(f, original, ids), intent = await admitDocumentGeneration(f.ctx, command, { db, env }),
      complete = await publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects: store() });
    expect(complete).toMatchObject({ documentId: original.documentId, id: intent.id, state: "COMPLETE" }); expect(intent.id).not.toBe(originalIntent.id);
    expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.findUniqueOrThrow({ where: { id: complete.versionId! } })))
      .toMatchObject({ number: 2, supersedesId: original.versionId, documentId: original.documentId });
    expect((await lineage(f.organizationId, original.documentId)).filter(row => oldRows.some(old => old.id === row.id))).toEqual(oldRows);
    expect(await money(f.organizationId)).toEqual(oldMoney);
    const amendedFile = await downloadDocumentVersion(f.ctx, { versionId: complete.versionId }, { db, env, objects: store() }),
      task = getDocument({ data: new Uint8Array(amendedFile.bytes), useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true });
    try { const pdf = await task.promise, page = await pdf.getPage(1), content = await page.getTextContent(), text = content.items.map(item => "str" in item ? item.str : "").join("\n");
      expect(text).toContain(f.marker + " AMENDED");
      if (financial) expect(text.replace(/\s/gu, "")).toContain(formatCurrency("fr", Money.of("9007199254740993.07", "MAD")).replace(/\s/gu, ""));
      else expect(text).toContain("Actual revised villa name");
    } finally { await task.destroy(); }
    expect((await downloadDocumentVersion(f.ctx, { versionId: original.versionId }, { db, env, objects: store() })).bytes).toEqual(originalFile.bytes);
    expect(await admitDocumentGeneration(f.ctx, f.command, { db, env })).toEqual(original);
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(original);
    const before = puts, forbidden = { render: vi.fn(() => Promise.reject(Error("Historical PDFs cannot be repriced"))) };
    expect(await publishDocumentGeneration(f.ctx, { instanceId: originalIntent.id }, { db, env, objects: store(), pdf: forbidden })).toEqual(original);
    expect(forbidden.render).not.toHaveBeenCalled(); expect(puts).toBe(before);
    const binding = await withTenant(db, f.organizationId, tx => tx.$queryRaw<Array<{ original: boolean; amended: boolean; crossed: boolean }>>`
      SELECT app_document_version_matches_instance(${f.organizationId}::uuid,${original.versionId}::uuid,${originalIntent.id}::uuid) AS original,
      app_document_version_matches_instance(${f.organizationId}::uuid,${complete.versionId}::uuid,${intent.id}::uuid) AS amended,
      app_document_version_matches_instance(${f.organizationId}::uuid,${complete.versionId}::uuid,${originalIntent.id}::uuid) AS crossed`);
    expect(binding).toEqual([{ original: true, amended: true, crossed: false }]);
  });
  it("serializes competing amendments of the same predecessor and retains the losing immutable intent", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), ids = await amendedTemplates(f),
      command = await amendmentCommand(f, original, ids), otherCommand = { ...command, idempotencyKey: randomUUID() },
      intents = await Promise.all([command, otherCommand].map(input => admitDocumentGeneration(f.ctx, input, { db, env }))), before = await lineage(f.organizationId, original.documentId),
      outcomes = await Promise.allSettled(intents.map(intent => publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects: store() })));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.findIndex(outcome => outcome.status === "rejected"), failed = outcomes[loser];
    expect(failed).toMatchObject({ status: "rejected", reason: { message: "document_source_changed" } });
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: [command, otherCommand][loser].idempotencyKey }, { db, env }))
      .toMatchObject({ id: intents[loser].id, state: "SOURCE_CHANGED", versionId: null });
    expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: original.documentId } }))).toBe(2);
    expect((await lineage(f.organizationId, original.documentId)).filter(row => before.some(old => old.id === row.id))).toEqual(before);
  });
  it("recovers the first selected amendment PDF after a lost object acknowledgement without rendering again", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), command = await amendmentCommand(f, original, await amendedTemplates(f)),
      intent = await admitDocumentGeneration(f.ctx, command, { db, env }), renderer = new DocumentPdfRenderer(), render = vi.fn(renderer.render.bind(renderer)); let lost = true;
    const objects = store(async (url, init) => { const response = await fetch(url, init); if (init?.method === "PUT" && lost) { lost = false; throw Error("Lost actual amendment acknowledgement"); } return response; });
    await expect(publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects, pdf: { render } })).rejects.toThrow("document_storage_unavailable");
    const retained = await lineage(f.organizationId, original.documentId), forbidden = { render: vi.fn(() => Promise.reject(Error("The first selected amendment must survive"))) },
      complete = await publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects, pdf: forbidden });
    expect(complete.state).toBe("COMPLETE"); expect(render).toHaveBeenCalledTimes(1); expect(forbidden.render).not.toHaveBeenCalled();
    expect((await lineage(f.organizationId, original.documentId)).filter(row => retained.some(old => old.id === row.id))).toEqual(retained);
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: command.idempotencyKey }, { db, env })).toEqual(complete);
  });
  it("requires held and current document edit authority before an amendment can be admitted", async () => {
    const f = await fixture(false, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), command = await amendmentCommand(f, original, await amendedTemplates(f)),
      held = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "document:edit")) } };
    await expect(admitDocumentGeneration(held, command, { db, env })).rejects.toThrow("document_unavailable");
    await withTenant(db, f.organizationId, async tx => { const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.organizationId, key: "document:edit" } });
      await tx.rolePermission.deleteMany({ where: { roleId: f.assignment.roleId, permissionId: permission.id } }); });
    await expect(admitDocumentGeneration(f.ctx, command, { db, env })).rejects.toThrow("document_unavailable");
    expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.count())).toBe(1);
    expect(await withTenant(db, f.organizationId, tx => tx.outboxEvent.count())).toBe(1);
  });
  it.each(["documents.instance_created", "documents.admitted", "documents.version_added"])("rolls back an amendment after edit authority is revoked at %s", async action => {
    const f = await fixture(true, "fr", true), first = await admitDocumentGeneration(f.ctx, f.command, { db, env }),
      original = await publishDocumentGeneration(f.ctx, { instanceId: first.id }, { db, env, objects: store() }), command = await amendmentCommand(f, original, await amendedTemplates(f)),
      intent = action === "documents.instance_created" ? null : await admitDocumentGeneration(f.ctx, command, { db, env }), before = await lineage(f.organizationId, original.documentId),
      originalMoney = await money(f.organizationId), write = auditWriter.writeAuditEvent; let revoked = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await write(tx, event);
      if (!revoked && event.action === action) { revoked = true; await withTenant(db, f.organizationId, async other => {
        const permission = await other.permission.findFirstOrThrow({ where: { organizationId: f.organizationId, key: "document:edit" } });
        await other.rolePermission.deleteMany({ where: { roleId: f.assignment.roleId, permissionId: permission.id } });
      }); } return result;
    });
    try { await expect(intent ? publishDocumentGeneration(f.ctx, { instanceId: intent.id }, { db, env, objects: store() }) : admitDocumentGeneration(f.ctx, command, { db, env })).rejects.toThrow("document_unavailable"); }
    finally { spy.mockRestore(); }
    expect(revoked).toBe(true); expect(await money(f.organizationId)).toEqual(originalMoney);
    expect((await lineage(f.organizationId, original.documentId)).filter(row => before.some(old => old.id === row.id))).toEqual(before);
    expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: original.documentId } }))).toBe(1);
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(original);
  });
});
describe("durable native generation admission", () => {
  it("executes only an actual tenant outbox reference, preserves its historical PDF after source edits and hides its origin after native grant revocation", async () => {
    const f=await fixture(),receipt=await admitDocumentGeneration(f.ctx,f.command,{db,env}),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{organizationId:f.organizationId,type:documentGenerationRequested}})),reference={organizationId:f.organizationId,outboxEventId:event.id},complete=await executeDocumentGenerationReference(reference,{db,env,objects:store()});
    const original=await downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:store()});
    await withTenant(db,f.organizationId,tx=>tx.property.update({where:{id:f.property.id},data:{name:"Actual later source name"}}));
    expect((await downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:store()})).bytes).toEqual(original.bytes);
    await expect(executeDocumentGenerationReference({...reference,outboxEventId:randomUUID()},{db,env,objects:store()})).rejects.toThrow("document_unavailable");
    await expect(executeDocumentGenerationReference({...reference,instanceId:receipt.id},{db,env,objects:store()})).rejects.toThrow();
    await withTenant(db,f.organizationId,async tx=>{const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"document_template:view"}});await tx.rolePermission.deleteMany({where:{organizationId:f.organizationId,roleId:f.assignment.roleId,permissionId:permission.id}});});
    expect((await readDocumentSourceWorkspace(f.ctx,{source:{kind:"PROPERTY",id:f.property.id}},{db})).items.map(item=>item.id)).not.toContain(receipt.documentId);
    await expect(downloadDocumentVersion(f.ctx,{versionId:complete.versionId},{db,env,objects:store()})).rejects.toThrow("document_unavailable");
  });
  it("rolls back version publication when create authority is revoked after the actual version audit, retaining the admitted original for recovery",async()=>{
    const f=await fixture(),receipt=await admitDocumentGeneration(f.ctx,f.command,{db,env}),write=auditWriter.writeAuditEvent;let revoked=false;
    const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await write(tx,event);if(!revoked&&event.action==="documents.version_added"){revoked=true;await withTenant(db,f.organizationId,async other=>{const permission=await other.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"document_instance:create"}});await other.rolePermission.deleteMany({where:{organizationId:f.organizationId,roleId:f.assignment.roleId,permissionId:permission.id}});});}return result;});
    try{await expect(publishDocumentGeneration(f.ctx,{instanceId:receipt.id},{db,env,objects:store()})).rejects.toThrow("document_unavailable");}finally{spy.mockRestore();}
    expect(revoked).toBe(true);expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:receipt.documentId}}))).toBe(0);expect(await withTenant(db,f.organizationId,tx=>tx.documentAdmission.count({where:{documentId:receipt.documentId}}))).toBe(1);
    expect(await withTenant(db,f.organizationId,tx=>tx.auditLog.count({where:{action:"documents.version_added",after:{path:["documentId"],equals:receipt.documentId}}}))).toBe(0);
  });
  it("enforces original generated PDF payload and immutable reference-only outbox evidence in native PostgreSQL",async()=>{
    const f=await fixture(),receipt=await admitDocumentGeneration(f.ctx,f.command,{db,env});await publishDocumentGeneration(f.ctx,{instanceId:receipt.id},{db,env,objects:store()});
    const row=await withTenant(db,f.organizationId,tx=>tx.documentAdmission.findFirstOrThrow({where:{documentId:receipt.documentId}})),input=JSON.parse(JSON.stringify(row.input)) as Prisma.InputJsonObject;
    for(const change of ["missing-cipher","wrong-instance","wrong-original-cap","wrong-command"]){
      await expect(withTenant(db,f.organizationId,tx=>{const id=randomUUID(),nonce=change==="wrong-command"?randomUUID():row.commandKey;return tx.documentAdmission.create({data:{...row,id,commandKey:nonce,input:{...input,...change==="wrong-instance"?{generationInstanceId:randomUUID()}:{},idempotencyKey:nonce},storageKey:`organizations/${f.organizationId}/documents/${row.documentId}/admissions/${id}.encrypted`,authorizationCap:change==="wrong-original-cap"?{}:JSON.parse(JSON.stringify(row.authorizationCap)) as Prisma.InputJsonValue,policySnapshot:JSON.parse(JSON.stringify(row.policySnapshot)) as Prisma.InputJsonValue,...change==="missing-cipher"?{payloadCipher:null}:{}}});})).rejects.toThrow("generated PDF payload requires its exact original native generation and actor");
    }
    const event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow());
    await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.update({where:{id:event.id},data:{payload:{instanceId:receipt.id,privateText:f.marker}}}))).rejects.toThrow("native generation reference identity is immutable");
    await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.delete({where:{id:event.id}}))).rejects.toThrow("native generation references are append-only");
    await withTenant(db,f.organizationId,tx=>tx.outboxEvent.update({where:{id:event.id},data:{attemptCount:{increment:1},lastError:"document_storage_unavailable"}}));
    expect((await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findUniqueOrThrow({where:{id:event.id}}))).payload).toEqual({instanceId:receipt.id});
  });
  it("retains terminal worker failure evidence without inventing a version, leaking clauses or discarding the original instance",async()=>{
    const f=await fixture(),receipt=await admitDocumentGeneration(f.ctx,f.command,{db,env}),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow()),result=await failDocumentGenerationReference({organizationId:f.organizationId,outboxEventId:event.id},{db});
    expect(result.recorded).toBe(true);expect(await withTenant(db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:receipt.documentId}}))).toBe(0);
    const audit=await withTenant(db,f.organizationId,tx=>tx.auditLog.findFirstOrThrow({where:{action:"documents.generation_failed"}}));expect(JSON.stringify(audit)).not.toContain(f.marker);expect(audit.after).toEqual({instanceId:receipt.id,outboxEventId:event.id});expect((await recoverDocumentGeneration(f.ctx,{idempotencyKey:f.command.idempotencyKey},{db,env})).state).toBe("PENDING");
  });
  it.each(["en", "fr"] as const)("publishes an actual %s PDF through encrypted native archive admission and authenticated download with exact original Money", async locale => {
    const f = await fixture(true, locale), originalMoney = await money(f.organizationId), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), before = puts;
    const objects = store(async (url, init) => {
      if (init?.method === "PUT") {
        const retained = await withTenant(db, f.organizationId, tx => tx.documentAdmission.findFirstOrThrow({ where: { organizationId: f.organizationId, documentId: receipt.documentId } }));
        expect(retained.payloadCipher!.length).toBeGreaterThan(retained.fileSize); expect(retained.contentType).toBe("application/pdf");
      }
      return fetch(url, init);
    }), complete = await publishDocumentGeneration(f.ctx, { instanceId: receipt.id }, { db, env, objects });
    expect(complete.state).toBe("COMPLETE"); expect(puts).toBe(before + 1); expect(await money(f.organizationId)).toEqual(originalMoney);
    const original = await downloadDocumentVersion(f.ctx, { versionId: complete.versionId }, { db, env, objects }), task = getDocument({ data: new Uint8Array(original.bytes), useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true }), pdf = await task.promise;
    try { const page = await pdf.getPage(1), content = await page.getTextContent(), text = content.items.map(item => "str" in item ? item.str : "").join("\n"); expect(text).toContain(f.marker); expect(text.replace(/\s/gu, "")).toContain(formatCurrency(locale, Money.of("9007199254740993.07", "MAD")).replace(/\s/gu, "")); } finally { await task.destroy(); }
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(complete); expect(await money(f.organizationId)).toEqual(originalMoney);
  });
  it("recovers the first encrypted PDF after a lost object acknowledgement without calling the provider again or rewriting history", async () => {
    const f = await fixture(), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), renderer = new DocumentPdfRenderer(), render = vi.fn(renderer.render.bind(renderer)); let lost = true;
    const objects = store(async (url, init) => { const response = await fetch(url, init); if (init?.method === "PUT" && lost) { lost = false; throw Error("Lost generated PDF object acknowledgement"); } return response; });
    await expect(publishDocumentGeneration(f.ctx, { instanceId: receipt.id }, { db, env, objects, pdf: { render } })).rejects.toThrow("document_storage_unavailable");
    const snapshot = () => withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT a.id::text,a.xmin::text,md5(to_jsonb(a)::text) AS body FROM document_admission a WHERE document_id=${receipt.documentId}::uuid`), original = await snapshot();
    expect(render).toHaveBeenCalledTimes(1); const forbidden = { render: vi.fn(() => Promise.reject(Error("A retained PDF must never be rerendered"))) }, completed = await publishDocumentGeneration(f.ctx, { instanceId: receipt.id }, { db, env, objects, pdf: forbidden });
    expect(completed.state).toBe("COMPLETE"); expect(forbidden.render).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(original);
    const before = puts; expect(await publishDocumentGeneration(f.ctx, { instanceId: receipt.id }, { db, env, objects, pdf: forbidden })).toEqual(completed); expect(puts).toBe(before); expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: receipt.documentId } }))).toBe(1);
  });
  it("denies PDF admission and object I/O after actual authority is revoked while the provider renders", async () => {
    const f = await fixture(), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), renderer = new DocumentPdfRenderer(), before = puts;
    const pdf = { async render(input: Parameters<DocumentPdfRenderer["render"]>[0]) { const bytes = await renderer.render(input); await withTenant(db, f.organizationId, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { validTo: new Date("2020-01-02") } })); return bytes; } };
    await expect(publishDocumentGeneration(f.ctx, { instanceId: receipt.id }, { db, env, objects: store(), pdf })).rejects.toThrow("document_unavailable"); expect(puts).toBe(before);
    expect(await withTenant(db, f.organizationId, tx => tx.documentAdmission.count({ where: { documentId: receipt.documentId } }))).toBe(0); expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: receipt.documentId } }))).toBe(0);
  });
  it("rolls back the instance, root, history and outbox when actual authority is revoked after its final admission audit", async () => {
    const f = await fixture(true), originalMoney = await money(f.organizationId), write = auditWriter.writeAuditEvent; let revoked = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await write(tx, event);
      if (!revoked && event.action === "documents.instance_created") {
        revoked = true; await withTenant(db, f.organizationId, other => other.roleAssignment.update({ where: { id: f.assignment.id }, data: { validTo: new Date("2020-01-02") } }));
      }
      return result;
    });
    try { await expect(admitDocumentGeneration(f.ctx, f.command, { db, env })).rejects.toThrow("document_unavailable"); } finally { spy.mockRestore(); }
    expect(revoked).toBe(true); expect(await withTenant(db, f.organizationId, tx => tx.document.count())).toBe(2);
    expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.count())).toBe(0); expect(await withTenant(db, f.organizationId, tx => tx.outboxEvent.count())).toBe(0);
    expect(await withTenant(db, f.organizationId, tx => tx.auditLog.count({ where: { action: "documents.instance_created" } }))).toBe(0); expect(await money(f.organizationId)).toEqual(originalMoney);
  });
  it("requires both current and held original-template export authority when recovering a pending native instance", async () => {
    const f = await fixture(); await admitDocumentGeneration(f.ctx, f.command, { db, env });
    const held = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "document_template:export")) } };
    await expect(recoverDocumentGeneration(held, { idempotencyKey: f.command.idempotencyKey }, { db, env })).rejects.toThrow("document_unavailable");
    await withTenant(db, f.organizationId, async tx => { const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.organizationId, key: "document_template:export" } }); await tx.rolePermission.deleteMany({ where: { organizationId: f.organizationId, roleId: f.assignment.roleId, permissionId: permission.id } }); });
    await expect(recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).rejects.toThrow("document_unavailable"); expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.count())).toBe(1);
  });
  it("isolates actual actor and tenant nonce ownership without disclosing another tenant's recorded work", async () => {
    const f = await fixture(), foreign = await fixture(); await admitDocumentGeneration(f.ctx, f.command, { db, env });
    const account = await withTenant(db, f.organizationId, async tx => { const person = await tx.person.create({ data: { organizationId: f.organizationId, displayName: "Different actual account" } }); return tx.userAccount.create({ data: { organizationId: f.organizationId, personId: person.id } }); }), other = { organizationId: f.organizationId, actorId: account.id, authContext: await authContextForAccount(f.organizationId, account.id, { db }) };
    await expect(recoverDocumentGeneration(other, { idempotencyKey: f.command.idempotencyKey }, { db, env })).rejects.toThrow("document_unavailable");
    expect(await recoverDocumentGeneration(foreign.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toMatchObject({ recorded: false, id: null });
    await expect(admitDocumentGeneration(foreign.ctx, f.command, { db, env })).rejects.toThrow("document_unavailable"); expect(await withTenant(db, foreign.organizationId, tx => tx.documentInstance.count())).toBe(0);
  });
  it("captures the original command before a caller can mutate its source, title or native language selection", async () => {
    const f = await fixture(), mutable = structuredClone(f.command), pending = admitDocumentGeneration(f.ctx, mutable, { db, env });
    mutable.title = "Later caller mutation"; mutable.source.id = randomUUID(); mutable.variantVersionIds.reverse(); mutable.templateVersionId = randomUUID();
    const receipt = await pending, row = await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: receipt.id } })), snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot);
    expect(snapshot.command.title).toBe(f.command.title); expect(snapshot.command.source).toEqual(f.command.source); expect(snapshot.command.templateVersionId).toBe(f.command.templateVersionId); expect(receipt.state).toBe("PENDING");
  });
  it("commits the authenticated original, actual instance and reference-only outbox before PDF or object I/O", async () => {
    const f = await fixture(), before = puts, receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), row = await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: receipt.id } })), snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot), input = openDocumentGenerationInput(snapshot.identity, Buffer.from(snapshot.payloadCipher, "base64"), env);
    expect(receipt.state).toBe("PENDING"); expect(input.source.title).toBe("Convention Actual original generated villa"); expect(JSON.stringify(snapshot)).not.toContain(f.marker); expect(puts).toBe(before); expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(receipt);
    const events = await withTenant(db, f.organizationId, tx => tx.outboxEvent.findMany()); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: documentGenerationRequested, payload: { instanceId: row.id }, idempotencyKey: documentGenerationOutboxKey(f.ctx.actorId, f.command.idempotencyKey) });
    expect(await withTenant(db, f.organizationId, tx => tx.documentVersion.count())).toBe(2); expect(JSON.stringify(await withTenant(db, f.organizationId, tx => tx.auditLog.findMany({ where: { resourceType: "document" } })))).not.toContain(f.marker);
  });
  it("serializes concurrent original nonces into one immutable native instance and one outbox reference", async () => {
    const f = await fixture(), receipts = await Promise.all([1, 2, 3].map(() => admitDocumentGeneration(f.ctx, f.command, { db, env })));
    expect(receipts[1]).toEqual(receipts[0]); expect(receipts[2]).toEqual(receipts[0]); expect(await withTenant(db, f.organizationId, tx => tx.documentInstance.count())).toBe(1); expect(await withTenant(db, f.organizationId, tx => tx.outboxEvent.count())).toBe(1);
    const snapshot = () => withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(i)::text) AS body FROM document_instance i WHERE id=${receipts[0].id}::uuid`), original = await snapshot(); await admitDocumentGeneration(f.ctx, f.command, { db, env }); expect(await snapshot()).toEqual(original);
    await expect(admitDocumentGeneration(f.ctx, { ...f.command, title: "Different original intent" }, { db, env })).rejects.toThrow("document_source_changed");
  });
  it("retains exact original financial Money and every original financial row and tuple version", async () => {
    const f = await fixture(true), before = await money(f.organizationId), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), row = await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: receipt.id } })), snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot), input = openDocumentGenerationInput(snapshot.identity, Buffer.from(snapshot.payloadCipher, "base64"), env);
    expect(input.source.blocks[0].text).toBe(f.marker + " " + formatCurrency("fr", Money.of("9007199254740993.07", "MAD"))); expect(input.source.privacy).toEqual(["financial"]); expect(await money(f.organizationId)).toEqual(before);
    await expect(admitDocumentGeneration(f.ctx, { ...f.command, values: { transaction_amount: "0.00" } }, { db, env })).rejects.toThrow(); expect(await money(f.organizationId)).toEqual(before);
  });
  it("reports a changed native source without repricing or replacing the original encrypted intent", async () => {
    const f = await fixture(), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), before = await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: receipt.id } }));
    await withTenant(db, f.organizationId, tx => tx.property.update({ where: { id: f.property.id }, data: { name: "Actual later property name" } }));
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toMatchObject({ id: receipt.id, state: "SOURCE_CHANGED", versionId: null }); expect((await withTenant(db, f.organizationId, tx => tx.documentInstance.findUniqueOrThrow({ where: { id: receipt.id } })))).toEqual(before);
  });
  it("prevents a pending generation nonce from being claimed or falsely dismissed by the ordinary upload protocol", async () => {
    const f = await fixture(), receipt = await admitDocumentGeneration(f.ctx, f.command, { db, env }), original = f.templates[0].command, draft = { documentId: original.documentId, source: original.source, typeKey: original.typeKey, title: original.title,
      supersedesId: original.supersedesId, effectiveFrom: original.effectiveFrom, definition: { ...original.definition, templateKey: "independent_original" } }, reviewed = await reviewDocumentTemplate(f.ctx, draft, { db });
    await expect(admitDocumentTemplate(f.ctx, { ...draft, idempotencyKey: f.command.idempotencyKey, reviewFingerprint: reviewed.reviewFingerprint, reason: original.reason }, { db, env })).rejects.toThrow("document_source_changed");
    await expect(recoverDocumentUpload(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db })).rejects.toThrow("document_unavailable");
    await expect(admitDocumentGeneration(f.ctx, { ...f.command, idempotencyKey: original.idempotencyKey }, { db, env })).rejects.toThrow("document_source_changed");
    expect(await recoverDocumentGeneration(f.ctx, { idempotencyKey: f.command.idempotencyKey }, { db, env })).toEqual(receipt); expect(await withTenant(db, f.organizationId, tx => tx.document.count())).toBe(3);
  });
});
