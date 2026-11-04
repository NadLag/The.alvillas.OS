import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { savePropertyTemplate, templateCatalog, templateVersionHistory, propertyTemplateState, changePropertyTemplate, TemplateAccessError } from "@/modules/core/application/property-template-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { FinancialTransactionResourceRepository } from "@/platform/ledger/financial-transaction-resource-repository";
import { Money } from "@/platform/money/money";
import { maskedValue, present } from "@/platform/authz/present";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { getConfigAdminModel, ConfigAuthorizationError } from "@/modules/config/application/config-service";
import { PropertyTemplateRepository } from "@/modules/core/infrastructure/property-template-repository";
import { listAuditHistory, exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Native scoped financial field masking", baseCurrency: "MAD" } }); await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "MAD", minorUnit: 2 } });
    const region = await tx.region.create({ data: { organizationId: org, name: "Native financial source region" } }), otherRegion = await tx.region.create({ data: { organizationId: org, name: "Different financial source region" } }),
      city = await tx.city.create({ data: { organizationId: org, regionId: region.id, name: "Marrakech" } }), otherCity = await tx.city.create({ data: { organizationId: org, regionId: otherRegion.id, name: "Rabat" } });
    const createProperty = (name: string, location: typeof city) => tx.property.create({ data: { organizationId: org, name, addressLine1: "Dedicated privacy fixture", city: location.name, cityId: location.id, regionId: location.regionId,
      propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const property = await createProperty("Actual financial source villa", city), other = await createProperty("Different financial source villa", otherCity); return { org, property, other, city, otherCity, region, otherRegion };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Fixture, finance?: { propertyId?: string; cityId?: string; regionId?: string; cap?: string; export?: boolean; extraKeys?: string[] }) {
  const identity = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Actual scoped financial reader" } }), account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } });
    const assignments: string[] = [];
    for (const [name, keys, scopeType, scopeId, conditions] of [
      ["operational", ["property:view", "property:edit", "property:export", "config_rule:view", "config_rule:create", "config_rule:configure", "audit_log:view", "audit_log:export"], "organization", null, null],
      ...(finance ? [["financial", ["financial_transaction:view", ...(finance.export ? ["financial_transaction:export"] : []), ...(finance.extraKeys ?? [])], finance.propertyId ? "property" : finance.cityId ? "city" : finance.regionId ? "region" : "organization", finance.propertyId ?? finance.cityId ?? finance.regionId ?? null, finance.cap ? { maxAmount: finance.cap } : null] as const] : [])
    ] as const) {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "mask_" + name + "_" + randomUUID(), name: "Explicit native masking grant" } }),
        permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      const assigned = await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType, scopeId,
        validFrom: new Date("2020-01-01"), ...(conditions ? { conditions } : {}) } }); assignments.push(assigned.id);
    }
    return { person, account, assignments };
  });
  return { organizationId: f.org, actorId: identity.account.id, personId: identity.person.id,
    authContext: { ...await authContextForAccount(f.org, identity.account.id, { db }), personId: identity.person.id }, ...identity };
}
async function serviceTemplate(f: Fixture) {
  const writer = await actor(f, {}), reason = "Private original service price 123.45 MAD and internal financial treatment", values = { rules: { "services.pricing": {
    services: [{ key: "chef", name: { en: "Chef", fr: "Chef", ar: "طاهٍ" }, pricing_model: "FIXED", amount: "123.45", currency: "MAD", available: true }] } } };
  const saved = await savePropertyTemplate(writer, { key: "private_services_" + randomUUID().replaceAll("-", ""), kind: "SERVICE_CATALOG", expectedVersion: 0, propertyId: f.property.id,
    name: { en: "Private configured services", fr: "Services configurés", ar: "خدمات معدة" }, values, status: "ACTIVE", reason }, { db, requestId: randomUUID() });
  return { saved, reason, values, writer };
}
describe("financial serializer privacy with actual PostgreSQL source grants", () => {
  it("protects original service-price audit reasons, scoped geography and independent CSV export", async () => {
    const f = await fixture(), source = await serviceTemplate(f), operational = await actor(f), filter = { resourceId: source.saved.id };
    const hidden = await listAuditHistory(operational, filter, { db }); expect(hidden.rows).toHaveLength(1);
    expect(hidden.rows[0]).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect((await exportAuditHistoryCsv(operational, filter, { db, requestId: randomUUID() })).includes("123.45")).toBe(false);
    for (const finance of [{ propertyId: f.property.id }, { cityId: f.city.id }, { regionId: f.region.id }]) {
      const viewer = await actor(f, finance); expect((await listAuditHistory(viewer, filter, { db })).rows[0].reason).toBe(source.reason);
      expect((await exportAuditHistoryCsv(viewer, filter, { db, requestId: randomUUID() })).includes("123.45")).toBe(false);
    }
    const exporter = await actor(f, { propertyId: f.property.id, export: true });
    expect((await exportAuditHistoryCsv(exporter, filter, { db, requestId: randomUUID() })).includes(source.reason)).toBe(true);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: exporter.assignments[1] }, data: { archivedAt: new Date() } }));
    expect((await exportAuditHistoryCsv(exporter, filter, { db, requestId: randomUUID() })).includes("123.45")).toBe(false);
    expect((await withTenant(db, f.org, tx => tx.propertyTemplateVersion.findUniqueOrThrow({ where: { id: source.saved.id } }))).reason).toBe(source.reason);
  });
  it("protects native staff compensation rule audit values and reasons separately from generic journal access", async () => {
    const f = await fixture(), writer = await actor(f, { extraKeys: ["staff_compensation:view"] }), reader = await actor(f, {}),
      rule = await withTenant(db, f.org, async tx => {
        const row = await new ConfigRuleRepository(tx, f.org).createVersion({ key: "staff.compensation", scopeType: "property", scopeId: f.property.id, value: { compensation_type: "SALARY", mode: "PER_MONTH", amount: "321.09", currency: "MAD" },
          effectiveFrom: new Date("2020-01-01"), createdBy: writer.actorId, reason: "Original private staff amount321.09 MAD" });
        await writeAuditEvent(tx, { organizationId: f.org, actorId: writer.actorId, action: "config_rule.version.created", resourceType: "config_rule", resourceId: row.id,
          propertyScopeId: f.property.id, after: row, reason: row.reason, requestId: randomUUID(), occurredAt: new Date() }); return row;
      });
    expect((await listAuditHistory(reader, { resourceId: rule.id }, { db })).rows[0]).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect((await listAuditHistory(writer, { resourceId: rule.id }, { db })).rows[0].reason).toBe(rule.reason);
    expect((await exportAuditHistoryCsv(writer, { resourceId: rule.id }, { db, requestId: randomUUID() })).includes("321.09")).toBe(false);
  });
  it("uses actual current city and region sources instead of treating a scope label as financial authority", async () => {
    const f = await fixture(), source = await serviceTemplate(f);
    for (const finance of [{ cityId: f.city.id }, { regionId: f.region.id }]) {
      const reader = await actor(f, finance), result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
      expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: source.values, reason: source.reason, restricted: false });
    }
    for (const finance of [{ cityId: f.otherCity.id }, { regionId: f.otherRegion.id }]) {
      const reader = await actor(f, finance), result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
      expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: null, reason: maskedValue, restricted: true });
    }
  });
  it("retains authorized original financial template history after a property is archived", async () => {
    const f = await fixture(), source = await serviceTemplate(f), reader = await actor(f, { propertyId: f.property.id });
    await withTenant(db, f.org, tx => tx.property.update({ where: { id: f.property.id }, data: { archivedAt: new Date() } }));
    const result = await templateVersionHistory(reader, source.saved.id, 1, f.property.id, { db }); expect(result.selected).toMatchObject({ values: source.values, reason: source.reason });
  });
  it("preserves non-financial configuration fields for authorized operational readers", async () => {
    const f = await fixture(), reader = await actor(f), reason = "Actual operational bedroom configuration", values = { property: { bedrooms: 2 } },
      saved = await savePropertyTemplate(reader, { key: "operating_" + randomUUID().replaceAll("-", ""), kind: "PROPERTY", expectedVersion: 0, propertyId: f.property.id,
        name: { en: "Operating bedrooms", fr: "Chambres", ar: "غرف النوم" }, values, status: "ACTIVE", reason }, { db, requestId: randomUUID() });
    expect((await templateCatalog(reader, { propertyId: f.property.id, kind: "PROPERTY" }, { db })).templates.find(row => row.id === saved.id)).toMatchObject({ values, reason, restricted: false });
  });
  it("protects configured financial costs and reasons in configuration browsing and preview", async () => {
    const f = await fixture(), writer = await actor(f, { extraKeys: ["company_ledger:view"] }), reader = await actor(f),
      rule = await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.ota_fee", scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
        createdBy: writer.actorId, value: { mode: "FIXED_AMOUNT", amount: "321.09", currency: "MAD" }, reason: "Private original OTA company cost321.09 MAD" }));
    const hidden = await getConfigAdminModel(reader, { ruleKey: "finance.ota_fee" }, { db }); expect(hidden.rules).toHaveLength(0); expect(JSON.stringify(hidden)).not.toContain("321.09");
    await expect(getConfigAdminModel(reader, { previewKey: "finance.ota_fee" }, { db })).rejects.toBeInstanceOf(ConfigAuthorizationError);
    const allowed = await getConfigAdminModel(writer, { ruleKey: "finance.ota_fee", previewKey: "finance.ota_fee" }, { db });
    expect(allowed.rules).toHaveLength(1); expect(allowed.rules[0].id).toBe(rule.id); expect(allowed.preview?.resolved?.valueJson).toContain("321.09");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: writer.assignments[1] }, data: { archivedAt: new Date() } }));
    expect((await getConfigAdminModel(writer, { ruleKey: "finance.ota_fee" }, { db })).rules).toHaveLength(0);
  });
  it("does not expose direct service-price rule values after current financial authority is revoked", async () => {
    const f = await fixture(), reader = await actor(f, { propertyId: f.property.id });
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "services.pricing", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"),
      createdBy: reader.actorId, value: { services: [{ key: "chef", name: { en: "Chef", fr: "Chef" }, pricing_model: "FIXED", amount: "321.09", currency: "MAD", available: true }] }, reason: "Private original property service price321.09" }));
    expect((await getConfigAdminModel(reader, { ruleKey: "services.pricing" }, { db })).rules).toHaveLength(1);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: reader.assignments[1] }, data: { archivedAt: new Date() } }));
    const hidden = await getConfigAdminModel(reader, { ruleKey: "services.pricing", previewKey: "services.pricing", previewScopeType: "property", previewScopeId: f.property.id }, { db });
    expect(hidden.rules).toHaveLength(0); expect(hidden.preview?.resolved).toBeNull(); expect(JSON.stringify(hidden)).not.toContain("321.09");
  });
  it("masks service pricing and its original free-text financial reason for operational catalog readers", async () => {
    const f = await fixture(), source = await serviceTemplate(f), reader = await actor(f), result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db }),
      row = result.templates.find(row => row.id === source.saved.id);
    expect(row).toMatchObject({ values: null, reason: maskedValue, restricted: true }); expect(JSON.stringify(result)).not.toContain("123.45");
    expect((await withTenant(db, f.org, tx => tx.propertyTemplateVersion.findUniqueOrThrow({ where: { id: source.saved.id } }))).reason).toBe(source.reason);
  });
  it("uses the actual source property and refuses unknown aggregate exposure under a money cap", async () => {
    const f = await fixture(), source = await serviceTemplate(f);
    for (const finance of [{ propertyId: f.other.id }, { propertyId: f.property.id, cap: "9999999999999999.99" }]) {
      const reader = await actor(f, finance), result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
      expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: null, reason: maskedValue, restricted: true });
    }
    const permitted = await actor(f, { propertyId: f.property.id }), result = await templateCatalog(permitted, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
    expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: source.values, reason: source.reason, restricted: false });
  });
  it("does not reuse a captured financial class after the stored financial grant is revoked", async () => {
    const f = await fixture(), source = await serviceTemplate(f), reader = await actor(f, { propertyId: f.property.id });
    expect((await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db })).templates.find(row => row.id === source.saved.id)?.values).toEqual(source.values);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: reader.assignments[1] }, data: { archivedAt: new Date() } }));
    const result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
    expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: null, reason: maskedValue, restricted: true });
  });
  it("protects actual financial version details and applied property history after a stored grant is revoked", async () => {
    const f = await fixture(), source = await serviceTemplate(f), reader = await actor(f, { propertyId: f.property.id });
    await changePropertyTemplate(source.writer, { action: "APPLY", propertyId: f.property.id, templateVersionId: source.saved.id, expectedRevision: 0,
      operationId: randomUUID(), reason: "Apply actual original private service pricing" }, { db, requestId: randomUUID() });
    expect((await templateVersionHistory(reader, source.saved.id, 1, f.property.id, { db })).selected.values).toEqual(source.values);
    expect(JSON.stringify(await propertyTemplateState(reader, f.property.id, "SERVICE_CATALOG", 1, { db }))).toContain("123.45");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: reader.assignments[1] }, data: { archivedAt: new Date() } }));
    await expect(templateVersionHistory(reader, source.saved.id, 1, f.property.id, { db })).rejects.toBeInstanceOf(TemplateAccessError);
    await expect(propertyTemplateState(reader, f.property.id, "SERVICE_CATALOG", 1, { db })).rejects.toBeInstanceOf(TemplateAccessError);
  });
  it("does not widen the caller's captured authority when stored financial permission is added", async () => {
    const f = await fixture(), source = await serviceTemplate(f), reader = await actor(f), permitted = await actor(f, { propertyId: f.property.id });
    await withTenant(db, f.org, async tx => {
      const role = await tx.roleAssignment.findUniqueOrThrow({ where: { id: permitted.assignments[1] } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: reader.actorId, personId: reader.personId, roleId: role.roleId, scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
    });
    const result = await templateCatalog(reader, { propertyId: f.property.id, kind: "SERVICE_CATALOG" }, { db });
    expect(result.templates.find(row => row.id === source.saved.id)).toMatchObject({ values: null, reason: maskedValue, restricted: true });
  });
  it("rejects financial template creation and application with a captured but revoked source grant", async () => {
    const f = await fixture(), source = await serviceTemplate(f);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: source.writer.assignments[1] }, data: { archivedAt: new Date() } }));
    await expect(savePropertyTemplate(source.writer, { key: source.saved.key, kind: "SERVICE_CATALOG", expectedVersion: 1, propertyId: f.property.id,
      name: source.saved.name, values: source.values, status: "ACTIVE", reason: "Captured writer must not create a financial version" }, { db, requestId: randomUUID() })).rejects.toBeInstanceOf(TemplateAccessError);
    await expect(changePropertyTemplate(source.writer, { action: "APPLY", propertyId: f.property.id, templateVersionId: source.saved.id, expectedRevision: 0,
      operationId: randomUUID(), reason: "Captured writer must not apply financial pricing" }, { db, requestId: randomUUID() })).rejects.toBeInstanceOf(TemplateAccessError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.propertyTemplateVersion.count({ where: { key: source.saved.key } })).toBe(1);
      expect(await tx.propertyTemplateRevision.count({ where: { propertyId: f.property.id } })).toBe(0);
    });
  });
  it("denies private command replay after source revocation and retains the original revision", async () => {
    const f = await fixture(), source = await serviceTemplate(f), input = { action: "APPLY", propertyId: f.property.id, templateVersionId: source.saved.id, expectedRevision: 0,
      operationId: randomUUID(), reason: "Original private financial application" }, original = await changePropertyTemplate(source.writer, input, { db, requestId: randomUUID() });
    expect(JSON.stringify(original)).toContain("123.45");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: source.writer.assignments[1] }, data: { archivedAt: new Date() } }));
    await expect(changePropertyTemplate(source.writer, input, { db, requestId: randomUUID() })).rejects.toBeInstanceOf(TemplateAccessError);
    expect(await withTenant(db, f.org, tx => tx.propertyTemplateRevision.findUniqueOrThrow({ where: { id: original.id } }))).toEqual(original);
  });
  it("rolls back a financial application when its stored source grant changes during the write", async () => {
    const f = await fixture(), source = await serviceTemplate(f), original = Object.getOwnPropertyDescriptor(PropertyTemplateRepository.prototype, "persistPropertyFields")!.value as PropertyTemplateRepository["persistPropertyFields"],
      spy = vi.spyOn(PropertyTemplateRepository.prototype, "persistPropertyFields").mockImplementation(async function (this: PropertyTemplateRepository, ...args) {
        const result = await original.apply(this, args);
        await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: source.writer.assignments[1] }, data: { archivedAt: new Date() } }));
        return result;
      });
    try {
      await expect(changePropertyTemplate(source.writer, { action: "APPLY", propertyId: f.property.id, templateVersionId: source.saved.id, expectedRevision: 0,
        operationId: randomUUID(), reason: "Current authority must survive the completed write" }, { db, requestId: randomUUID() })).rejects.toBeInstanceOf(TemplateAccessError);
      await withTenant(db, f.org, async tx => {
        expect(await tx.propertyTemplateVersion.count({ where: { key: source.saved.key } })).toBe(1);
        expect(await tx.propertyTemplateRevision.count({ where: { propertyId: f.property.id } })).toBe(0);
        expect(await tx.configRule.count({ where: { key: "services.pricing", scopeId: f.property.id } })).toBe(0);
      });
    } finally { spy.mockRestore(); }
  });
  it("protects exact original journal exposure and independent export with real stored source grants", async () => {
    const f = await fixture(), author = await actor(f, {}), journal = await withTenant(db, f.org, async tx => {
      const repository = new FinanceRepository(tx, f.org), bank = await repository.ensureLedgerAccount({ code: "NATIVE_MASK_BANK", name: "Actual masking bank location", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
        claim = await repository.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Actual masking claim ownership", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }), amount = Money.of("9007199254740993.07", "MAD"), dimensions = { property_id: f.property.id };
      return repository.createFinancialTransaction({ reference: "NATIVE-MASK:" + randomUUID(), description: "Original scoped masking journal", occurredAt: new Date("2032-05-01T00:00:00Z"), createdBy: author.actorId, idempotencyKey: randomUUID(),
        postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount, bucket: "OWNER_REVENUE", dimensions }] });
    });
    const native = (await withTenant(db, f.org, tx => new FinancialTransactionResourceRepository(tx, f.org).transactionResources([journal.id]))).get(journal.id)!;
    const resource = { ...native, type: "property", id: f.property.id, financialRecordId: journal.id, data: { name: f.property.name, revenue: "9007199254740993.07" } },
      policy = { revenue: { dataClass: "financial" as const, requiredPermission: "financial_transaction:view" } };
    for (const finance of [{ propertyId: f.other.id }, { propertyId: f.property.id, cap: "9007199254740993.06" }]) {
      const reader = await actor(f, finance); expect(present({ ...reader.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view", resource, policy).revenue).toBe(maskedValue);
    }
    const viewer = await actor(f, { propertyId: f.property.id, cap: "9007199254740993.07" }), exporter = await actor(f, { propertyId: f.property.id, cap: "9007199254740993.07", export: true });
    expect(present({ ...viewer.authContext, visibleDataClasses: new Set() }, "view", resource, policy).revenue).toBe(resource.data.revenue);
    expect(present({ ...viewer.authContext, visibleDataClasses: new Set() }, "export", resource, policy).revenue).toBe(maskedValue);
    expect(present({ ...exporter.authContext, visibleDataClasses: new Set() }, "export", resource, policy).revenue).toBe(resource.data.revenue);
  });
});
