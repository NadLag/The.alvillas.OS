import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSupplierInvoiceFields, createSupplierInvoiceInput, supplierInvoiceTotal, supplierInvoiceFields } from "@/modules/finance/domain/supplier-invoice";

const draft = () => ({ supplierId: randomUUID(), idempotencyKey: randomUUID(), invoiceNumber: "INV-2026-009", issuedOn: "2026-10-28", currency: "MAD", purpose: "Configured maintenance invoice",
  lines: [{ category: "maintenance", amount: "2400.00" }], reason: "Dedicated invoice authoring acceptance" });
describe("supplier invoice source inputs", () => {
  it("retains unknown and explicitly past due dates without inventing a payment deadline", () => {
    expect(createSupplierInvoiceInput.parse(draft()).dueOn).toBeNull();
    expect(createSupplierInvoiceInput.parse({ ...draft(), dueOn: "2026-09-01" }).dueOn).toBe("2026-09-01");
  });
  it("normalizes exact cents and source identities while retaining authored invoice numbers", () => {
    const parsed = createSupplierInvoiceInput.parse({ ...draft(), invoiceNumber: " inv-A ", lines: [{ category: "maintenance", amount: "2400.0", costCenter: " office " }] });
    const fields = supplierInvoiceFields.strip().parse(parsed);
    expect(canonicalSupplierInvoiceFields(fields)).toMatchObject({ invoiceNumber: "inv-A", lines: [{ amount: "2400.00", propertyId: null, reservationId: null, costCenter: "office" }] });
    expect(supplierInvoiceTotal(canonicalSupplierInvoiceFields(fields)).toJSON()).toEqual({ amount: "2400.00", currency: "MAD" });
  });
  it.each(["0", "-1", "1.001", "1e3", "NaN", "Infinity", "10000000000000000.00"])("rejects invalid or non-storage money %s", amount => {
    expect(createSupplierInvoiceInput.safeParse({ ...draft(), lines: [{ category: "maintenance", amount }] }).success).toBe(false);
  });
  it("rejects an overflowing exact invoice total before any database write", () => {
    expect(createSupplierInvoiceInput.safeParse({ ...draft(), lines: Array.from({ length: 2 }, () => ({ category: "maintenance", amount: "9999999999999999.99" })) }).success).toBe(false);
  });
  it("supports 500 distinct property allocations with exact cent conservation", () => {
    const parsed = createSupplierInvoiceInput.parse({ ...draft(), lines: Array.from({ length: 500 }, () => ({ propertyId: randomUUID(), category: "maintenance", amount: "100.01" })) });
    expect(supplierInvoiceTotal(parsed).toJSON().amount).toBe("50005.00");
  });
  it("requires a property for reservation amounts and validates civil dates", () => {
    expect(createSupplierInvoiceInput.safeParse({ ...draft(), lines: [{ reservationId: randomUUID(), category: "maintenance", amount: "10" }] }).success).toBe(false);
    expect(createSupplierInvoiceInput.safeParse({ ...draft(), issuedOn: "2026-02-30" }).success).toBe(false);
  });
});
