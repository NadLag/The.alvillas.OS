import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountantExportInputSchema, validateAccountantExportDocument, AccountantExportCapacityError, AccountantExportSourceError } from "@/modules/finance/domain/accountant-export";

const source = () => ({ organizationId: randomUUID(), kind: "TRANSACTIONS", currency: "MAD", fromOn: "2031-05-01", toOn: "2031-05-31", timezone: "Africa/Casablanca",
  policy: { id: randomUUID(), version: 2 }, sourceFingerprint: "a".repeat(64), generatedAt: "2031-06-01T00:00:00Z", columns: ["postingId", "amount", "description"],
  rows: [{ identity: randomUUID(), cells: { postingId: { kind: "IDENTIFIER", value: randomUUID() }, amount: { kind: "MONEY", value: "1234567890123456.07" },
    description: { kind: "TEXT", value: "=Original configured description" } } }] });

describe("complete exact accountant export documents", () => {
  it("retains large exact money and unmodified source text without any floating conversion", () => {
    const input = source(), before = structuredClone(input), result = validateAccountantExportDocument(input, 10);
    expect(result.rows[0].cells.amount?.value).toBe("1234567890123456.07"); expect(result.rows[0].cells.description?.value).toBe("=Original configured description");
    expect(input).toEqual(before);
  });
  it("refuses duplicated identities, duplicated columns and silent configured-capacity truncation", () => {
    const input = source();
    expect(() => validateAccountantExportDocument({ ...input, rows: [input.rows[0], input.rows[0]] }, 10)).toThrow(AccountantExportSourceError);
    expect(() => validateAccountantExportDocument({ ...input, columns: ["amount", "amount"] }, 10)).toThrow(AccountantExportSourceError);
    expect(() => validateAccountantExportDocument({ ...input, rows: [input.rows[0], { ...input.rows[0], identity: randomUUID() }] }, 1)).toThrow(AccountantExportCapacityError);
  });
  it.each(["0.001", "1e2", "-0.00", "000.07", "NaN", "Infinity", "1.5"])("rejects noncanonical money %s before any attachment exists", amount => {
    const input = source(); input.rows[0].cells.amount.value = amount; expect(() => validateAccountantExportDocument(input, 10)).toThrow(AccountantExportSourceError);
  });
  it("requires an explicit valid date interval and denies tenant, pagination and accounting-treatment injection", () => {
    const input = { kind: "INCOME", format: "CSV", locale: "fr", fromOn: "2031-05-01", toOn: "2031-05-31", currency: "MAD", reason: "Export actual original income facts" };
    expect(accountantExportInputSchema.safeParse(input).success).toBe(true);
    for (const changed of [{ ...input, organizationId: randomUUID() }, { ...input, after: "opaque" }, { ...input, taxRate: 20 }, { ...input, toOn: "2031-04-30" }])
      expect(accountantExportInputSchema.safeParse(changed).success).toBe(false);
  });
  it("cannot relabel financial columns as free text to bypass exact-money validation", () => {
    const input = source(); input.rows[0].cells.amount.kind = "TEXT"; input.rows[0].cells.amount.value = "1e2";
    expect(() => validateAccountantExportDocument(input, 10)).toThrow(AccountantExportSourceError);
  });
  it("requires explicit typed absent values instead of silently dropping a selected financial column", () => {
    const input = source();
    expect(() => validateAccountantExportDocument({ ...input, rows: [{ ...input.rows[0], cells: { postingId: input.rows[0].cells.postingId, description: input.rows[0].cells.description } }] }, 10)).toThrow(AccountantExportSourceError);
    const absent = { ...input, rows: [{ ...input.rows[0], cells: { ...input.rows[0].cells, amount: { kind: "MONEY", value: null } } }] };
    expect(validateAccountantExportDocument(absent, 10).rows[0].cells.amount?.value).toBeNull();
  });
});
