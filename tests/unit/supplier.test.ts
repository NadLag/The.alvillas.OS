import { describe, expect, it } from "vitest";
import { createSupplierInput, updateSupplierInput, supplierFields } from "@/modules/finance/domain/supplier";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import type { AuthContext } from "@/platform/authz/authorize";

const org = "018f0a0b-0000-7000-9000-000000000001", key = "018f0a0b-0000-7000-9000-000000000002";
const fields = { displayName: "  Dedicated laundry provider  ", category: "Laundry", email: "ACCOUNTS@example.test", phone: "+212661234567" };
describe("canonical supplier source", () => {
  it("normalizes supplier data without inventing business categories", () => {
    expect(supplierFields.parse(fields)).toEqual({ displayName: "Dedicated laundry provider", category: "Laundry", email: "accounts@example.test", phone: "+212661234567", contactName: null, address: null, externalReference: null });
    expect(supplierFields.parse({ displayName: "Supplier", category: "Owner-authored category" }).category).toBe("Owner-authored category");
  });
  it.each([{ displayName: "" }, { category: "" }, { email: "wrong" }, { phone: "0661234567" }, { address: "a".repeat(1001) }, { organizationId: org }])("rejects invalid or injected source data %j", patch => {
    expect(createSupplierInput.safeParse({ ...fields, idempotencyKey: key, reason: "Supplier source acceptance", ...patch }).success).toBe(false);
  });
  it("requires exact edit versions and attributed reasons", () => {
    expect(updateSupplierInput.safeParse({ ...fields, id: key, expectedVersion: -1, reason: "Supplier source acceptance" }).success).toBe(false);
    expect(createSupplierInput.safeParse({ ...fields, idempotencyKey: key, reason: "x" }).success).toBe(false);
  });
  it.each(["owner", "property", "financial_record"] as const)("rejects wildcard %s grants for complete organization sources", scopeType => {
    const ctx: AuthContext = { organizationId: org, permissions: new Set(["supplier:view"]), scopes: [{ organizationId: org, scopeType }] };
    expect(authorizeOrganizationSource(ctx, "view", { type: "supplier", organizationId: org }, new Date())).toBe(false);
  });
  it("retains caller restrictions while filtering organization assignment candidates", () => {
    const ctx: AuthContext = { organizationId: org, permissions: new Set(), scopes: [], assignments: [{ permissions: new Set(["supplier:view"]), scope: { organizationId: org, scopeType: "organization" } }] };
    expect(authorizeOrganizationSource(ctx, "view", { type: "supplier", organizationId: org }, new Date())).toBe(false);
    expect(authorizeOrganizationSource({ ...ctx, permissions: new Set(["supplier:view"]) }, "view", { type: "supplier", organizationId: org }, new Date())).toBe(true);
    expect(authorizeOrganizationSource({ ...ctx, permissions: new Set(["supplier:view"]), assignments: [{ ...ctx.assignments![0], conditions: { maxAmount: "100" } }] }, "view", { type: "supplier", organizationId: org }, new Date())).toBe(false);
  });
});
