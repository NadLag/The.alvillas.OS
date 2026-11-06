import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { DocumentSourceFacts } from "@/modules/documents/infrastructure/document-repository";
import { DocumentTemplateSourceRepository } from "@/modules/documents/infrastructure/document-template-source-repository";

function fixture(amount: string | number) {
  const organizationId = randomUUID(), id = randomUUID(), resource = { organizationId, id, type: "financial_transaction" as const, dataClass: "financial" as const }, native: DocumentSourceFacts = {
    reference: { kind: "FINANCIAL_TRANSACTION", id }, resource, checks: [], fingerprint: "a".repeat(64), snapshot: {}, archived: false, label: "Original journal"
  }, repository = new DocumentTemplateSourceRepository({} as TenantTransaction, organizationId);
  vi.spyOn(repository, "source").mockResolvedValue({ source: resource, extraChecks: [], identity: "b".repeat(64), transaction: { id, reference: "Original journal", occurredAt: "2026-11-06T08:00:00Z", amount, currency: "MAD" } });
  return { repository, native };
}
describe("exact native document financial bindings", () => {
  it.each([9007199254740992, Number.NaN, Number.POSITIVE_INFINITY])("rejects numeric native amount %s instead of converting it into a decimal string", async amount => {
    const f = fixture(amount); await expect(f.repository.templateSourceValues(f.native, ["transaction_amount"])).rejects.toThrow("document_template_binding_unavailable");
  });
  it("retains exact original decimal strings through the shared Money boundary", async () => {
    const f = fixture("9007199254740993.07"), result = await f.repository.templateSourceValues(f.native, ["transaction_amount"]), value = result.bindings.get("transaction_amount");
    expect(value?.kind).toBe("MONEY"); if (value?.kind !== "MONEY") throw Error("Native Money binding required"); expect(value.value.toJSON()).toEqual({ amount: "9007199254740993.07", currency: "MAD" }); expect(value.privacy).toEqual(["financial"]);
  });
});
