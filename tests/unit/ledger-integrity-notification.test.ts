import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/platform/authz/authorize";
import { financialRuleSourceChecks, financialRuleKeysIn, protectedFinancialRuleKey } from "@/platform/config/financial-rule-authority";
import { ledgerIntegrityPolicyKey, ledgerIntegrityRoutingKey } from "@/modules/finance/domain/ledger-integrity";
import { canReadLedgerIntegrityFailure, ledgerIntegrityNoticeSchema } from "@/modules/finance/domain/ledger-integrity-notification";
import { notificationDestination } from "@/platform/notifications/notification";
import { notificationRoutingSaveSchema } from "@/platform/notifications/notification-routing";
import { defaultNotificationPreferences, shouldDeliverNotification } from "@/platform/notifications/notification-preferences";

const org = randomUUID(), actor = randomUUID(), eventId = randomUUID(), policyId = randomUUID(), keys = [...new Set(["audit_log:view", "config_rule:view",
  ...financialRuleSourceChecks(org, ledgerIntegrityPolicyKey).map(check => check.resource.type + ":" + check.action)])],
  target = { type: "config_rule", organizationId: org, id: policyId, dataClass: "financial" as const, ruleKey: ledgerIntegrityPolicyKey, ledgerIntegrityFailed: true, notificationEventId: eventId };
const context = (permissions: readonly string[] = keys, scopes: AuthContext["scopes"] = [{ organizationId: org, scopeType: "organization" }]): AuthContext => ({ organizationId: org, userAccountId: actor, permissions: new Set(permissions), scopes });

describe("source-bound critical ledger failure notices", () => {
  it("requires every independent original financial source and the readable audit destination", () => {
    expect(canReadLedgerIntegrityFailure(context(), target)).toBe(true);
    for (const key of keys) expect(canReadLedgerIntegrityFailure(context(keys.filter(value => value !== key)), target), key).toBe(false);
  });
  it("does not let a financial class label, property scope, foreign tenant or forged target widen access", () => {
    const labelled = { ...context([]), visibleDataClasses: new Set(["financial"]) };
    expect(canReadLedgerIntegrityFailure(labelled, target)).toBe(false);
    expect(canReadLedgerIntegrityFailure(context(keys, [{ organizationId: org, scopeType: "property", scopeId: randomUUID() }]), target)).toBe(false);
    expect(canReadLedgerIntegrityFailure(context(), { ...target, organizationId: randomUUID() })).toBe(false);
    expect(canReadLedgerIntegrityFailure(context(), { ...target, ledgerIntegrityFailed: false })).toBe(false);
  });
  it("opens the audit only for the original notification event and recipient", () => {
    const input = { kind: "ledger_integrity_failed" as const, recipientId: actor, targetId: eventId };
    expect(notificationDestination(context(), input, target, "fr")).toBe("/fr/app/audit");
    expect(notificationDestination(context(), { ...input, targetId: randomUUID() }, target, "fr")).toBeNull();
    expect(notificationDestination(context(), { ...input, recipientId: randomUUID() }, target, "fr")).toBeNull();
  });
  it("retains only strict source references and explicit organization-level recipients", () => {
    const routing = { roles: [], people: [randomUUID()], assigned: false, channels: ["email", "in_app"] },
      notice = { runId: randomUUID(), policyId, routingRuleId: randomUUID(), routing };
    expect(ledgerIntegrityNoticeSchema.safeParse(notice).success).toBe(true);
    expect(ledgerIntegrityNoticeSchema.safeParse({ ...notice, amount: "999.99" }).success).toBe(false);
    for (const invalid of [{ ...routing, assigned: true }, { ...routing, channels: [] }, { ...routing, people: [] }]) expect(ledgerIntegrityNoticeSchema.safeParse({ ...notice, routing: invalid }).success).toBe(false);
    expect(notificationRoutingSaveSchema.safeParse({ kind: "ledger_integrity_failed", propertyId: randomUUID(), routing, reason: "Explicit financial failure audience" }).success).toBe(false);
  });
  it("keeps configured critical email and inbox delivery while honoring disabled push", () => {
    const preferences = defaultNotificationPreferences(); preferences.in_app.enabled = false; preferences.email.enabled = false;
    expect(shouldDeliverNotification("ledger_integrity_failed", "email", preferences)).toBe(true);
    expect(shouldDeliverNotification("ledger_integrity_failed", "in_app", preferences)).toBe(true);
    expect(shouldDeliverNotification("ledger_integrity_failed", "push", preferences)).toBe(false);
    preferences.push = { enabled: true, account: false, operations: false };
    expect(shouldDeliverNotification("ledger_integrity_failed", "push", preferences)).toBe(true);
  });
  it("protects failure routing values and retained JSON pointers as financial configuration", () => {
    expect(protectedFinancialRuleKey(ledgerIntegrityRoutingKey)).toBe(true);
    expect(financialRuleKeysIn({ key: ledgerIntegrityRoutingKey, changes: { ["/rules/" + ledgerIntegrityRoutingKey + "/people"]: [] } })).toEqual([ledgerIntegrityRoutingKey]);
  });
});
