import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { financialRuleKeysIn, protectedFinancialRuleKey } from "@/platform/config/financial-rule-authority";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import type { AuditHistoryRow } from "@/modules/audit/infrastructure/audit-repository";

const org = randomUUID(), id = randomUUID(), base = { organizationId: org, actorId: id, personId: id,
  authContext: { organizationId: org, userAccountId: id, permissions: new Set(["audit_log:view", "audit_log:export"]), scopes: [{ organizationId: org, scopeType: "organization" as const }] } };
const row: AuditHistoryRow = { id, actorId: id, resourceId: id, resourceType: "config_rule", action: "config.rule.created", propertyScopeId: null, before: null,
  after: { key: "finance.ota_fee", value: { mode: "FIXED_AMOUNT", amount: "321.09", currency: "MAD" } }, reason: "Private original OTA cost321.09 MAD", requestId: id,
  occurredAt: new Date(), createdAt: new Date(), ipAddress: null, deviceId: null };
const actor = (keys: string[]) => ({ ...base, authContext: { ...base.authContext, permissions: new Set([...base.authContext.permissions, ...keys]) } });
const serviceRow: AuditHistoryRow = { ...row, after: { key: "services.pricing", value: { amount: "123.45", currency: "MAD" } }, reason: "Private original service cost123.45 MAD" };
describe("complete financial rule field classification", () => {
  it("protects registered and retained legacy financial definitions without classifying unrelated operating settings", () => {
    for (const key of ["finance.commission", "finance.ota_fee", "finance.bank_statements", "finance.legacy_retired_rate", "staff.compensation_monthly_earnings"]) expect(protectedFinancialRuleKey(key)).toBe(true);
    for (const key of ["ops.recurring_tasks", "staff.management_policy", "feature_flag.finance_label"]) expect(protectedFinancialRuleKey(key)).toBe(false);
  });
  it("classifies native rule names, stored snapshots and original JSON pointer changes", () => {
    expect(financialRuleKeysIn({ key: "finance.ota_fee", snapshot: { "finance.commission": { rate_bps: 650 } }, changes: { "/rules/finance.bank_statements/accounts": [] } }).sort())
      .toEqual(["finance.bank_statements", "finance.commission", "finance.ota_fee"]);
  });
  it("masks financial rule payloads and reasons for audit-only access", () => {
    const hidden = presentAuditHistoryRow(base, row); expect(hidden).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(row.after).toMatchObject({ value: { amount: "321.09" } });
  });
  it("keeps company cost policy and export behind independent current source permissions", () => {
    expect(presentAuditHistoryRow(actor(["financial_transaction:view"]), row).after).toBe(maskedValue);
    const viewer = actor(["financial_transaction:view", "company_ledger:view"]);
    expect(presentAuditHistoryRow(viewer, row).after).toEqual(row.after); expect(presentAuditHistoryRow(viewer, row, "export").after).toBe(maskedValue);
    expect(presentAuditHistoryRow(actor(["financial_transaction:view", "company_ledger:view", "financial_transaction:export", "company_ledger:export"]), row, "export").after).toEqual(row.after);
  });
  it("masks original service pricing reasons alongside the private audit payload", () => {
    expect(presentAuditHistoryRow(base, serviceRow)).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(serviceRow.reason).toContain("123.45");
  });
  it("requires independent financial source export for retained service-price audit history", () => {
    const viewer = actor(["financial_transaction:view"]);
    expect(presentAuditHistoryRow(viewer, serviceRow)).toMatchObject({ after: serviceRow.after, reason: serviceRow.reason });
    expect(presentAuditHistoryRow(viewer, serviceRow, "export")).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(presentAuditHistoryRow(actor(["financial_transaction:view", "financial_transaction:export"]), serviceRow, "export")).toMatchObject({ after: serviceRow.after, reason: serviceRow.reason });
  });
  it("protects direct staff compensation configuration and its original reason from operational audit access", () => {
    const compensation = { ...serviceRow, after: { key: "staff.compensation", value: { amount: "123.45", currency: "MAD" } } };
    expect(presentAuditHistoryRow(base, compensation)).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(presentAuditHistoryRow(actor(["staff_compensation:view"]), compensation).after).toEqual(compensation.after);
  });
  it("cannot qualify complete service definitions under an unknown exposure or a partial time window", () => {
    for (const conditions of [{ maxAmount: "9999999999999999.99" }, { timeWindow: { startsAt: "2020-01-01T00:00:00Z" } }]) {
      const viewer = actor(["financial_transaction:view"]), authority = { ...viewer, authContext: { ...viewer.authContext,
        assignments: [{ scope: viewer.authContext.scopes[0], permissions: base.authContext.permissions },
          { scope: viewer.authContext.scopes[0], permissions: new Set(["financial_transaction:view"]), conditions }] } };
      expect(presentAuditHistoryRow(authority, serviceRow)).toMatchObject({ after: maskedValue, reason: maskedValue });
    }
  });
  it.each([["team.compensation.preview", "staff_compensation"], ["team.wallet.create", "wallet"]])("protects the independent financial export action for %s", (action, type) => {
    const source = { ...serviceRow, resourceType: "team_member", action, after: { personId: id, amount: "123.45", currency: "MAD" } }, viewer = actor([type + ":view"]);
    expect(presentAuditHistoryRow(viewer, source)).toMatchObject({ after: source.after, reason: source.reason });
    expect(presentAuditHistoryRow(viewer, source, "export")).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(presentAuditHistoryRow(actor([type + ":view", type + ":export"]), source, "export")).toMatchObject({ after: source.after, reason: source.reason });
  });
});
