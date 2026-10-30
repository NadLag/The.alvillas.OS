import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import type { AuditHistoryRow } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";

const organizationId = "00000000-0000-4000-8000-000000000001";
const propertyId = "00000000-0000-4000-8000-000000000002";
const context: AuditActorContext = {
  organizationId,
  actorId: organizationId,
  personId: organizationId,
  authContext: {
    organizationId,
    permissions: new Set(["audit_log:view", "audit_log:export"]),
    scopes: [{ organizationId, scopeType: "organization" }]
  }
};
const row = (resourceType: string, after: Prisma.JsonValue): AuditHistoryRow => ({
  id: propertyId,
  actorId: organizationId,
  resourceType,
  action: "property_template.apply",
  resourceId: propertyId,
  propertyScopeId: propertyId,
  ipAddress: null,
  deviceId: null,
  before: { values: { "/rules/services.pricing/services/@key:chef/amount": "800.00" } },
  after,
  reason: "Reviewed service price",
  requestId: propertyId,
  occurredAt: new Date(0),
  createdAt: new Date(0)
});
describe("service template audit privacy", () => {
  it.each([
    ["team.compensation.create", "staff_compensation:view"],
    ["team.compensation.preview", "staff_compensation:view"],
    ["team.document.upload", "staff_document:view"],
    ["team.wallet.link", "wallet:view"],
    ["identity.person.create", "identity:edit"],
    ["team.assignment.create", "role:assign"]
  ])(
    "protects %s payloads and free-text reasons from audit-only and unrelated financial access",
    (event, permission) => {
      const source = {
        ...row("team_member", { personId: propertyId, amount: "500.25" }),
        action: event,
        reason: "Private staff agreement 500.25"
      };
      for (const action of ["view", "export"] as const) {
        const finance = {
          ...context,
          authContext: {
            ...context.authContext,
            permissions: new Set([...context.authContext.permissions, "financial_transaction:view"])
          }
        };
        for (const actor of [context, finance]) {
          const result = presentAuditHistoryRow(actor, source, action);
          expect(result.reason).toBe(maskedValue);
          expect(result.after).toBe(maskedValue);
          expect(JSON.stringify(result)).not.toContain("500.25");
        }
        const permitted = {
          ...context,
          authContext: {
            ...context.authContext,
            permissions: new Set([...context.authContext.permissions, permission])
          }
        };
        expect(presentAuditHistoryRow(permitted, source, action)).toEqual(source);
      }
    }
  );
  it("keeps staff leave reasons private independently of financial permission", () => {
    const source = {
      ...row("team_member", { personId: propertyId, kind: "LEAVE" }),
      action: "team.availability.request",
      reason: "Sensitive leave reason"
    };
    expect(presentAuditHistoryRow(context, source).reason).toBe(maskedValue);
    const own = { ...context, personId: propertyId };
    expect(presentAuditHistoryRow(own, source).reason).toBe(source.reason);
  });
  it.each([
    row("property_template", {
      kind: "SERVICE_CATALOG",
      values: { rules: { "services.pricing": { services: [{ amount: "800.00" }] } } }
    }),
    row("property_template_revision", {
      snapshot: { rules: { "services.pricing": { services: [{ amount: "800.00" }] } } }
    }),
    row("config_rule", { key: "services.pricing", value: { services: [{ amount: "800.00" }] } })
  ])(
    "masks $resourceType payloads for audit-only access while preserving originals and scoped financial access",
    (source) => {
      for (const action of ["view", "export"] as const) {
        const result = presentAuditHistoryRow(context, source, action);
        expect(result).toMatchObject({
          id: source.id,
          resourceId: source.resourceId,
          reason: source.reason,
          before: maskedValue,
          after: maskedValue
        });
        expect(JSON.stringify(result)).not.toContain("800.00");
        const financial = {
          ...context,
          authContext: {
            ...context.authContext,
            permissions: new Set([...context.authContext.permissions, "financial_transaction:view"])
          }
        };
        expect(presentAuditHistoryRow(financial, source, action)).toEqual(source);
        const scoped = {
          ...financial,
          authContext: {
            ...financial.authContext,
            assignments: [
              {
                permissions: context.authContext.permissions,
                scope: { organizationId, scopeType: "organization" as const }
              },
              {
                permissions: new Set(["financial_transaction:view"]),
                scope: { organizationId, scopeType: "property" as const, scopeId: propertyId }
              }
            ]
          }
        };
        expect(presentAuditHistoryRow(scoped, source, action)).toEqual(source);
        expect(
          presentAuditHistoryRow(scoped, { ...source, propertyScopeId: organizationId }, action).after
        ).toBe(maskedValue);
        expect(presentAuditHistoryRow(scoped, { ...source, propertyScopeId: null }, action).after).toBe(
          maskedValue
        );
      }
      expect(JSON.stringify(source)).toContain("800.00");
    }
  );
  it("keeps operational template history readable without financial permission", () => {
    const operational = {
      ...row("property_template", { kind: "PROPERTY", values: { property: { bedrooms: 4 } } }),
      before: null
    };
    expect(presentAuditHistoryRow(context, operational)).toEqual(operational);
  });
});
