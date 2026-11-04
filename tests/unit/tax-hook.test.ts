import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectTaxPolicyHooks, TaxHookConfigurationError, taxHookInputSchema, type TaxPolicySource } from "@/modules/finance/domain/tax-hook";

const org = randomUUID(), property = randomUUID(), other = randomUUID(), at = "2031-05-01T00:00:00Z";
const category = { key: "fixture_category", labels: { en: "Configured fixture category", fr: "Catégorie de test configurée", ar: "فئة اختبار معدة" } };
const contexts = [
  { kind: "PROPERTY", properties: { mode: "SELECTED", ids: [property] } },
  { kind: "SERVICE", properties: { mode: "ANY" }, services: { mode: "SELECTED", keys: ["fixture_service"] } },
  { kind: "TRANSACTION", properties: { mode: "COMPANY" }, transactionTypes: { mode: "SELECTED", keys: ["fixture_transaction"] } }
];
const entry = { key: "configured_fixture", rate_bps: 725, amount: "1234567890123456.07", currency: "MAD", tax_hook: { category, contexts } };
const source = (value: unknown = { taxes: [entry] }): TaxPolicySource => ({ organizationId: org, id: randomUUID(), key: "finance.tax", version: 1,
  scopeType: "organization", scopeId: null, lifecycle: "ACTIVE", effectiveFrom: new Date("2031-01-01"), effectiveTo: null, value });
const target = { kind: "PROPERTY", propertyId: property, occurredAt: at };

describe("configured tax interfaces without assumed country treatment", () => {
  it("keeps no policy, deferred legacy metadata and an explicit nonmatching policy distinct without a fabricated zero", () => {
    expect(projectTaxPolicyHooks(org, null, target)).toMatchObject({ status: "NO_POLICY", source: null, rates: [], assessedLiability: null });
    expect(projectTaxPolicyHooks(org, source({ taxes: [{ key: "original_service", rate_bps: 2000, currency: "MAD" }] }), target))
      .toMatchObject({ status: "DEFERRED", deferredTaxKeys: ["original_service"], rates: [], assessedLiability: null });
    expect(projectTaxPolicyHooks(org, source(), { ...target, propertyId: other })).toMatchObject({ status: "NO_MATCH", rates: [], assessedLiability: null });
  });
  it("retains exact original values and policy/category/rate identity without assessing or rounding a liability", () => {
    const original = source(), before = structuredClone(original), result = projectTaxPolicyHooks(org, original, target);
    expect(result).toMatchObject({ status: "MATCHED", source: { id: original.id, key: "finance.tax", version: 1 }, categories: [category],
      rates: [{ key: entry.key, amount: "1234567890123456.07", rateBps: 725, currency: "MAD", serviceAssessment: null }],
      rules: [{ reference: { policyRuleId: original.id, taxKey: entry.key, contextIndex: 0 }, categoryKey: category.key, rateKey: entry.key }], assessedLiability: null });
    expect(original).toEqual(before);
  });
  it("matches only explicitly configured service and transaction contexts", () => {
    const original = source();
    expect(projectTaxPolicyHooks(org, original, { kind: "SERVICE", propertyId: other, serviceKey: "fixture_service", occurredAt: at }).rules).toHaveLength(1);
    expect(projectTaxPolicyHooks(org, original, { kind: "SERVICE", propertyId: null, serviceKey: "another_service", occurredAt: at }).rules).toHaveLength(0);
    expect(projectTaxPolicyHooks(org, original, { kind: "TRANSACTION", propertyId: null, transactionType: "fixture_transaction", occurredAt: at }).rules).toHaveLength(1);
    expect(projectTaxPolicyHooks(org, original, { kind: "TRANSACTION", propertyId: property, transactionType: "fixture_transaction", occurredAt: at }).rules).toHaveLength(0);
  });
  it("retains the original explicit service assessment fields instead of changing existing service calculations", () => {
    const assessment = { basis: "ACTUAL_COLLECTED_GROSS", method: "BASIS_POINTS", rounding: "HALF_UP_AT_LEDGER_PRECISION" };
    const result = projectTaxPolicyHooks(org, source({ taxes: [{ ...entry, service_assessment: assessment }] }), target);
    expect(result.rates[0].serviceAssessment).toEqual(assessment); expect(result.assessedLiability).toBeNull();
  });
  it("uses the effective half-open source interval and retains retired historical versions", () => {
    const original = { ...source(), lifecycle: "RETIRED", effectiveTo: new Date("2031-06-01") };
    expect(projectTaxPolicyHooks(org, original, target).status).toBe("MATCHED");
    expect(projectTaxPolicyHooks(org, original, { ...target, occurredAt: original.effectiveFrom.toISOString() }).status).toBe("MATCHED");
    expect(() => projectTaxPolicyHooks(org, original, { ...target, occurredAt: original.effectiveTo.toISOString() })).toThrow(TaxHookConfigurationError);
    expect(() => projectTaxPolicyHooks(org, original, { ...target, occurredAt: "2030-12-31T23:59:59Z" })).toThrow(TaxHookConfigurationError);
  });
  it("rejects foreign tenant policies, draft versions, invalid source keys and another property's scope", () => {
    for (const changed of [{ ...source(), organizationId: randomUUID() }, { ...source(), lifecycle: "DRAFT" }, { ...source(), key: "finance.commission" },
      { ...source(), scopeType: "property", scopeId: other }, { ...source(), version: 0 }])
      expect(() => projectTaxPolicyHooks(org, changed, target)).toThrow(TaxHookConfigurationError);
  });
  it("rejects ambiguous tax identities and conflicting labels for one original category", () => {
    expect(() => projectTaxPolicyHooks(org, source({ taxes: [entry, entry] }), target)).toThrow(TaxHookConfigurationError);
    expect(() => projectTaxPolicyHooks(org, source({ taxes: [entry, { ...entry, key: "another_fixture", tax_hook: { ...entry.tax_hook, category: { ...category, labels: { ...category.labels, en: "Different meaning" } } } }] }), target)).toThrow(TaxHookConfigurationError);
  });
  it("rejects overlapping applicable contexts for one tax rather than duplicating or silently choosing a rate", () => {
    const policy = source({ taxes: [{ ...entry, tax_hook: { category, contexts: [contexts[0], { kind: "PROPERTY", properties: { mode: "ANY" } }] } }] });
    expect(() => projectTaxPolicyHooks(org, policy, target)).toThrow(TaxHookConfigurationError);
  });
  it("rejects supplied money or extra context fields and duplicate selectors without widening applicability", () => {
    expect(taxHookInputSchema.safeParse({ ...target, amount: "0.07" }).success).toBe(false);
    expect(() => projectTaxPolicyHooks(org, source({ taxes: [{ ...entry, tax_hook: { category, contexts: [{ kind: "PROPERTY", properties: { mode: "SELECTED", ids: [property, property.toUpperCase()] } }] } }] }), target)).toThrow();
  });
});
