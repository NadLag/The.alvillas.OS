import { z } from "zod";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import type { Resource } from "@/platform/authz/authorize";

export function supplierInvoiceCostResource(organizationId: string, invoice: { id: string; state: string; createdBy: string },
  line: { propertyId: string | null; reservationId: string | null; property?: { cityId: string | null; regionId: string | null } | null },
  amount: Money, occurredOn: string, timezone: string): Resource {
  return { type: "supplier_invoice", organizationId, id: invoice.id, financialRecordId: invoice.id, propertyId: line.propertyId,
    reservationId: line.reservationId, region: line.property?.regionId, city: line.property?.cityId, amount: amount.toJSON().amount,
    assignedUserAccountId: invoice.createdBy, occurredAt: calendarDateStart(occurredOn, timezone), dataClass: "financial", status: invoice.state };
}

const id = z.uuid().transform(value => value.toLowerCase());
const moneyText = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).refine(value => /[1-9]/u.test(value));
const optionalId = id.nullish().transform(value => value ?? null);
export const supplierInvoiceLineInput = z.object({ propertyId: optionalId, reservationId: optionalId,
  category: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u), costCenter: z.string().trim().max(120).nullish().transform(value => value || null), amount: moneyText
}).strict().refine(line => !line.reservationId || Boolean(line.propertyId), { path: ["propertyId"], message: "Reservation requires its property source" });
export const supplierInvoiceFields = z.object({ invoiceNumber: z.string().trim().min(1).max(160), issuedOn: z.iso.date(),
  dueOn: z.iso.date().nullish().transform(value => value ?? null), currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(1000),
  lines: z.array(supplierInvoiceLineInput).min(1)
}).strict().superRefine((fields, ctx) => {
  if (!/^[A-Z]{3}$/u.test(fields.currency) || fields.lines.some(line => !moneyText.safeParse(line.amount).success)) return;
  const total = fields.lines.reduce((sum, line) => sum.add(Money.of(line.amount, fields.currency)), Money.zero(fields.currency));
  if (!moneyText.safeParse(total.toJSON().amount).success) ctx.addIssue({ code: "custom", path: ["lines"], message: "Invoice total exceeds exact money storage" });
});
const reason = z.string().trim().min(6).max(500);
export const createSupplierInvoiceInput = supplierInvoiceFields.safeExtend({ supplierId: id, idempotencyKey: id, reason });
export const updateSupplierInvoiceInput = supplierInvoiceFields.safeExtend({ id, expectedVersion: z.number().int().nonnegative(), reason });
export const archiveSupplierInvoiceInput = z.object({ id, expectedVersion: z.number().int().nonnegative(), archived: z.boolean(), reason }).strict();
export const supplierInvoiceFilters = z.object({ query: z.string().trim().max(160).optional(), supplierId: id.optional(), includeArchived: z.boolean().optional(), after: id.optional() }).strict();
export const supplierInvoiceHistoryInput = z.object({ revisionId: id.optional(), beforeVersion: z.number().int().nonnegative().optional() }).strict();
export type SupplierInvoiceFields = z.output<typeof supplierInvoiceFields>;
export function supplierInvoiceTotal(fields: SupplierInvoiceFields): Money {
  return fields.lines.reduce((total, line) => total.add(Money.of(line.amount, fields.currency)), Money.zero(fields.currency));
}
export function canonicalSupplierInvoiceFields(raw: unknown): SupplierInvoiceFields {
  const fields = supplierInvoiceFields.parse(raw);
  return { ...fields, lines: fields.lines.map(line => ({ ...line, amount: Money.of(line.amount, fields.currency).toJSON().amount })) };
}
