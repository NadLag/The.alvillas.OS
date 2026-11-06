import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { formatCurrency } from "@/i18n/format";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { resolveDocumentTemplateValues } from "@/modules/documents/application/document-template-values";
import { documentTemplateMediaType } from "@/modules/documents/domain/document-template-format";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL; if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw Error("Owned native PostgreSQL required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
async function fixture(withInstance = true) {
  const organizationId = randomUUID(); await admin.organization.create({ data: { id: organizationId, name: "Actual native PDF values", baseCurrency: "MAD" } }); await ensureStandardIdentitySetup(organizationId, { db });
  const saved = await withTenant(db, organizationId, async tx => {
    const property = await tx.property.create({ data: { organizationId, name: "Villa originale {{literal}}", addressLine1: "Original entered address", city: "Marrakech", propertyType: "VILLA", bedrooms: 3, bathrooms: 2, maxGuests: 6, amenities: [], photoUrls: [] } }), person = await tx.person.create({ data: { organizationId, displayName: "Actual native author" } }), account = await tx.userAccount.create({ data: { organizationId, personId: person.id } }), role = await tx.role.create({ data: { organizationId, key: "pdf_values_" + randomUUID(), name: "Explicit native PDF authority" } });
    const keys = ["document:view", "document:export", "property:view", "property:export", "property_finance:view", "property_finance:export", "financial_transaction:view", "financial_transaction:export", ...(withInstance ? ["document_instance:view", "document_instance:export"] : [])], permissions = await tx.permission.findMany({ where: { organizationId, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId, roleId: role.id, permissionId: permission.id })) });
    const assignment = await tx.roleAssignment.create({ data: { organizationId, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
    await new ConfigRuleRepository(tx, organizationId).createVersion({ key: "documents.archive", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Explicit native values acceptance policy", value: { source: "NATIVE_DOCUMENT_ARCHIVE", encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY", storage_url_seconds: 30, upload_admission: { window_seconds: 3600, max_requests: 100 }, upload_transport: { window_seconds: 3600, max_requests: 100 }, types: [
      { key: "property_agreement", labels: { en: "Property agreement", fr: "Convention de propriété", ar: "اتفاقية العقار" }, sources: ["PROPERTY"], privacy: ["operational"], content_types: ["application/pdf", documentTemplateMediaType], max_bytes: 1048576 },
      { key: "journal_record", labels: { en: "Original journal", fr: "Écriture originale", ar: "القيد الأصلي" }, sources: ["FINANCIAL_TRANSACTION"], privacy: ["financial"], content_types: ["application/pdf", documentTemplateMediaType], max_bytes: 1048576 }
    ] } }); return { property, person, account, assignment };
  });
  const ctx = { organizationId, actorId: saved.account.id, authContext: { ...await authContextForAccount(organizationId, saved.account.id, { db }), personId: saved.person.id } }; return { organizationId, ctx, ...saved };
}
const definition = () => ({ schemaVersion: 1, templateKey: "property_agreement", locale: "fr", title: "Convention {{property}}", variables: [{ key: "property", kind: "TEXT" }, { key: "property_capacity", kind: "INTEGER" }], blocks: [{ kind: "PARAGRAPH", text: "{{property}} / {{property_capacity}}" }] });

describe("authorized native document template values", () => {
  it("reads actual property fields and typed capacity without reparsing inserted tokens or mutating the source", async () => {
    const f = await fixture(), original = await withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(p)::text) AS body FROM property p WHERE id=${f.property.id}::uuid`), result = await resolveDocumentTemplateValues(f.ctx, { kind: "PROPERTY", id: f.property.id }, definition(), "property_agreement", { db });
    expect(result.rendered.title).toBe("Convention Villa originale {{literal}}"); expect(result.rendered.blocks[0].text).toBe("Villa originale {{literal}} / 6"); expect(result.rendered.privacy).toEqual(["operational"]); expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(await withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(p)::text) AS body FROM property p WHERE id=${f.property.id}::uuid`)).toEqual(original); expect(await withTenant(db, f.organizationId, tx => tx.document.count())).toBe(0);
  });
  it("changes the exact native values fingerprint after a real source name amendment", async () => {
    const f = await fixture(), source = { kind: "PROPERTY", id: f.property.id }, before = await resolveDocumentTemplateValues(f.ctx, source, definition(), "property_agreement", { db });
    await withTenant(db, f.organizationId, tx => tx.property.update({ where: { id: f.property.id }, data: { name: "Actual amended villa name" } }));
    const after = await resolveDocumentTemplateValues(f.ctx, source, definition(), "property_agreement", { db }); expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint); expect(after.rendered.title).toBe("Convention Actual amended villa name"); expect(before.rendered.title).toBe("Convention Villa originale {{literal}}");
  });
  it("retains exact native journal Money and immutable original financial rows", async () => {
    const f = await fixture(), amount = Money.of("9007199254740993.07", "MAD"), journal = await withTenant(db, f.organizationId, async tx => {
      const finance = new FinanceRepository(tx, f.organizationId), bank = await finance.ensureLedgerAccount({ code: "PDF_NATIVE_BANK", name: "Original physical custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }), claim = await finance.ensureLedgerAccount({ code: "PDF_NATIVE_OWNER", name: "Original owner entitlement", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }), dimensions = { property_id: f.property.id };
      return finance.createFinancialTransaction({ reference: "PDF_NATIVE:" + randomUUID(), description: "Original native PDF financial source", idempotencyKey: randomUUID(), createdBy: f.ctx.actorId, occurredAt: await finance.clock(), postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount, bucket: "OWNER_REVENUE", dimensions }] });
    }), snapshot = () => withTenant(db, f.organizationId, tx => tx.$queryRaw`SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY id`), before = await snapshot(), template = { ...definition(), variables: [{ key: "transaction_amount", kind: "MONEY" }, { key: "transaction_reference", kind: "TEXT" }], title: "{{transaction_reference}}", blocks: [{ kind: "PARAGRAPH", text: "{{transaction_amount}}" }] }, result = await resolveDocumentTemplateValues(f.ctx, { kind: "FINANCIAL_TRANSACTION", id: journal.id }, template, "journal_record", { db });
    expect(result.rendered.title).toBe(journal.reference); expect(result.rendered.blocks[0].text).toBe(formatCurrency("fr", amount)); expect(result.rendered.privacy).toEqual(["financial"]); expect(await snapshot()).toEqual(before);
  });
  it("denies another tenant, an actor mismatch and stale captured grants after native revocation", async () => {
    const f = await fixture(), foreign = await fixture(), source = { kind: "PROPERTY", id: f.property.id };
    await expect(resolveDocumentTemplateValues(foreign.ctx, source, definition(), "property_agreement", { db })).rejects.toThrow("document_unavailable");
    await expect(resolveDocumentTemplateValues({ ...f.ctx, actorId: randomUUID() }, source, definition(), "property_agreement", { db })).rejects.toThrow("document_unavailable");
    await withTenant(db, f.organizationId, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { validTo: new Date("2020-01-02") } }));
    await expect(resolveDocumentTemplateValues(f.ctx, source, definition(), "property_agreement", { db })).rejects.toThrow("document_unavailable");
  });
  it("requires configured PDF type and independent instance authority even for an authored template with zero variables", async () => {
    const f = await fixture(false), plain = { ...definition(), title: "Authored original clause", variables: [], blocks: [{ kind: "PARAGRAPH", text: "Original authored clause" }] }, source = { kind: "PROPERTY", id: f.property.id };
    await expect(resolveDocumentTemplateValues(f.ctx, source, plain, "property_agreement", { db })).rejects.toThrow("document_unavailable");
    await expect(resolveDocumentTemplateValues(f.ctx, source, plain, "invented_type", { db })).rejects.toThrow("document_unavailable");
  });
  it("refuses undefined native keys and cross-kind values instead of inventing a financial amount", async () => {
    const f = await fixture(), source = { kind: "PROPERTY", id: f.property.id }, template = { ...definition(), title: "{{transaction_amount}}", variables: [{ key: "transaction_amount", kind: "MONEY" }], blocks: [{ kind: "PARAGRAPH", text: "{{transaction_amount}}" }] };
    await expect(resolveDocumentTemplateValues(f.ctx, source, template, "property_agreement", { db })).rejects.toThrow("document_template_binding_unavailable");
    await expect(resolveDocumentTemplateValues(f.ctx, source, { ...definition(), variables: [{ key: "property", kind: "MONEY" }, { key: "property_capacity", kind: "INTEGER" }] }, "property_agreement", { db })).rejects.toThrow("document_template_binding_unavailable");
  });
});
