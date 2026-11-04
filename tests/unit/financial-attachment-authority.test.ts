import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorize, type AuthContext, type Resource, type ScopeType } from "@/platform/authz/authorize";
import { financialAttachmentAuthorityChecks } from "@/platform/authz/financial-attachment-resource";
import type { NativeFinancialResource } from "@/platform/ledger/financial-transaction-resource-repository";

const org = randomUUID(), id = randomUUID(), rootId = randomUUID(), propertyId = randomUUID(), source: NativeFinancialResource = {
  organizationId: org, type: "financial_transaction", id, financialRecordId: id, propertyId, dataClass: "financial", amount: "9007199254740993.07", occurredAt: new Date("2032-05-01T00:00:00Z") };
const auth = (permissions: string[], scopeType: ScopeType = "organization", scopeId?: string): AuthContext => ({ organizationId: org, permissions: new Set(permissions), scopes: [{ organizationId: org, scopeType, scopeId }] });
const allowed = (ctx: AuthContext, native = source, action: "view" | "create" | "export" = "view") => {
  const checks = financialAttachmentAuthorityChecks(native, action, rootId); return Boolean(checks?.every(check => authorize(ctx, check.action, check.resource)));
};
const keys = ["financial_transaction:view", "financial_transaction:export", "financial_attachment:view", "financial_attachment:create", "financial_attachment:export"];
describe("financial document source authority", () => {
  it("requires the original financial source and independent document permission", () => {
    expect(allowed(auth(keys))).toBe(true);
    for (const key of ["financial_transaction:view", "financial_attachment:view"]) expect(allowed(auth(keys.filter(value => value !== key)))).toBe(false);
    expect(allowed(auth(["property:view"]))).toBe(false);
  });
  it("requires independent original source export and document export rights", () => {
    expect(allowed(auth(keys), source, "export")).toBe(true);
    for (const key of ["financial_transaction:export", "financial_attachment:export"]) expect(allowed(auth(keys.filter(value => value !== key)), source, "export")).toBe(false);
  });
  it("retains exact Money exposure and actual source property conditions", () => {
    const capped = (amount: string): AuthContext => ({ ...auth(keys), assignments: [{ permissions: new Set(keys), scope: { organizationId: org, scopeType: "property", scopeId: propertyId }, conditions: { maxAmount: amount } }] });
    expect(allowed(capped("9007199254740993.07"))).toBe(true); expect(allowed(capped("9007199254740993.06"))).toBe(false);
    expect(allowed(auth(keys, "property", randomUUID()))).toBe(false); expect(allowed(capped("9999999999999999.99"), { ...source, amount: undefined })).toBe(false);
  });
  it("keeps the logical file identity stable while retaining the separate original journal identity", () => {
    const checks = financialAttachmentAuthorityChecks(source, "view", rootId)!;
    expect(checks[0].resource).toMatchObject({ id, financialRecordId: id }); expect(checks.at(-1)?.resource).toMatchObject({ id: rootId, financialRecordId: id, type: "financial_attachment" });
    expect(allowed(auth(keys, "financial_record", id))).toBe(true);
  });
  it("requires original salary, employee claim and financial source authority", () => {
    const salary: Resource = { ...source, type: "staff_compensation" }, claim: Resource = { ...source, type: "employee_payable" },
      native = { ...source, salarySources: [salary], compensationRoot: claim, financialSources: [source] };
    expect(allowed(auth([...keys, "staff_compensation:view", "employee_payable:view"]), native)).toBe(true);
    for (const permissions of [keys, [...keys, "staff_compensation:view"], [...keys, "employee_payable:view"]]) expect(allowed(auth(permissions), native)).toBe(false);
  });
  it("refuses unbound, empty or foreign-tenant salary source facts", () => {
    for (const native of [{ ...source, salarySources: [] }, { ...source, salarySources: [{ ...source, type: "staff_compensation" }] },
      { ...source, salarySources: [{ ...source, organizationId: randomUUID(), type: "staff_compensation" }], financialSources: [source], compensationRoot: { ...source, type: "employee_payable" } }])
      expect(financialAttachmentAuthorityChecks(native, "view", rootId)).toBeNull();
  });
  it("retains independent original wallet restrictions", () => {
    const walletId = randomUUID(), native = { ...source, walletSources: [{ ...source, type: "wallet", id: walletId, walletId }] };
    expect(allowed(auth(keys), native)).toBe(false); expect(allowed(auth([...keys, "wallet:view"]), native)).toBe(true);
  });
  it("refuses a fabricated non-journal resource or missing original identity", () => {
    expect(financialAttachmentAuthorityChecks({ ...source, type: "task" }, "view")).toBeNull();
    expect(financialAttachmentAuthorityChecks({ ...source, id: undefined }, "view")).toBeNull();
  });
});
