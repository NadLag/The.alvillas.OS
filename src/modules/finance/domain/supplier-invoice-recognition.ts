import { z } from "zod";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";

const money = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u), currency: z.string().regex(/^[A-Z]{3}$/u) });
const allocation = z.object({ owner: money, alvillas: money, guest: money });
const ownerPolicy = z.object({ ownerId: z.uuid(), ownerName: z.string(), shareBps: z.number().int().min(0).max(10000), sourceAmount: money, allocation });
const frozenLine = z.object({ id: z.uuid(), position: z.number().int().positive(), propertyId: z.uuid().nullable(), reservationId: z.uuid().nullable(),
  amount: money, category: z.string(), costCenter: z.string().nullable(), policy: z.object({ schemaVersion: z.literal(1), sourceKind: z.literal("supplier_invoice_line"),
    invoiceId: z.uuid(), revisionId: z.uuid(), lineId: z.uuid(), propertyId: z.uuid().nullable(), reservationId: z.uuid().nullable(),
    occurredOn: z.iso.date(), timezone: z.string().min(1), amount: money, category: z.string(), allocation, policies: z.array(z.unknown()).min(1) }) });
const frozenSource = z.object({ schemaVersion: z.literal(1), invoiceId: z.uuid(), revisionId: z.uuid(), supplierId: z.uuid(), sourceInvoiceVersion: z.number().int().nonnegative(),
  occurredOn: z.iso.date(), amount: money, lines: z.array(frozenLine).min(1) });

export type SupplierInvoiceRecognitionSource = {
  organizationId: string; invoiceId: string; revisionId: string; supplierId: string; sourceInvoiceVersion: number;
  occurredOn: string; amount: string; currency: string;
  lines: ReadonlyArray<{ id: string; position: number; propertyId: string | null; reservationId: string | null; amount: string; currency: string; category: string; costCenter: string | null }>;
};
export class SupplierInvoiceRecognitionSourceError extends Error {}

/** Read immutable submitted terms; recognition must never resolve replacement allocation rules. */
export function supplierInvoiceRecognitionCosts(source: SupplierInvoiceRecognitionSource, snapshot: unknown) {
  const frozen = frozenSource.parse(snapshot), denied = () => { throw new SupplierInvoiceRecognitionSourceError("Submitted invoice costs do not match their immutable source"); };
  if (frozen.invoiceId !== source.invoiceId || frozen.revisionId !== source.revisionId || frozen.supplierId !== source.supplierId ||
    frozen.sourceInvoiceVersion !== source.sourceInvoiceVersion || frozen.occurredOn !== source.occurredOn || source.lines.length !== frozen.lines.length) denied();
  const amount = Money.of(source.amount, source.currency);
  const read = (value: z.infer<typeof money>) => { const result = Money.of(value.amount, value.currency); if (result.currency !== source.currency) denied(); return result; };
  if (!read(frozen.amount).equals(amount) || !amount.amount.gt(0)) denied();
  const ids = new Set<string>(), actual = new Map(source.lines.map(line => [line.id, line]));
  if (actual.size !== source.lines.length) denied();
  let total = Money.zero(source.currency);
  const costs = frozen.lines.map(line => {
    const original = actual.get(line.id), policy = line.policy;
    if (!original || ids.has(line.id)) return denied(); ids.add(line.id);
    const value = read(line.amount), originalAmount = Money.of(original.amount, original.currency);
    if (!value.amount.gt(0) || !value.equals(originalAmount) || line.position !== original.position || line.propertyId !== original.propertyId ||
      line.reservationId !== original.reservationId || line.category !== original.category || line.costCenter !== original.costCenter ||
      policy.invoiceId !== source.invoiceId || policy.revisionId !== source.revisionId || policy.lineId !== line.id || policy.propertyId !== line.propertyId ||
      policy.reservationId !== line.reservationId || policy.occurredOn !== source.occurredOn || policy.category !== line.category || !read(policy.amount).equals(value)) denied();
    total = total.add(value);
    const allocations = { ownerAmount: read(policy.allocation.owner), alvillasAmount: read(policy.allocation.alvillas), guestAmount: read(policy.allocation.guest) };
    if (!allocations.ownerAmount.add(allocations.alvillasAmount).add(allocations.guestAmount).equals(value)) denied();
    const policies = line.propertyId ? z.array(ownerPolicy).min(1).parse(policy.policies) : [];
    if (!line.propertyId) {
      const company = z.array(z.object({ organizationId: z.uuid() })).length(1).parse(policy.policies);
      if (company[0].organizationId !== source.organizationId || line.reservationId || !allocations.ownerAmount.amount.isZero() || !allocations.guestAmount.amount.isZero()) denied();
    } else {
      if (new Set(policies.map(owner => owner.ownerId)).size !== policies.length || policies.reduce((sum, owner) => sum + owner.shareBps, 0) !== 10000) denied();
      let slices = Money.zero(source.currency), owners = slices, company = slices, guests = slices;
      for (const owner of policies) {
        const slice = read(owner.sourceAmount), ownerAmount = read(owner.allocation.owner), companyAmount = read(owner.allocation.alvillas), guestAmount = read(owner.allocation.guest);
        if (!ownerAmount.add(companyAmount).add(guestAmount).equals(slice)) denied();
        slices = slices.add(slice); owners = owners.add(ownerAmount); company = company.add(companyAmount); guests = guests.add(guestAmount);
      }
      if (!slices.equals(value) || !owners.equals(allocations.ownerAmount) || !company.equals(allocations.alvillasAmount) || !guests.equals(allocations.guestAmount)) denied();
    }
    if (allocations.guestAmount.amount.gt(0) && !line.reservationId) denied();
    return { id: line.id, position: line.position, propertyId: line.propertyId, reservationId: line.reservationId, category: line.category, costCenter: line.costCenter,
      amount: value, allocation: allocations, timezone: policy.timezone, sourceOccurredAt: calendarDateStart(source.occurredOn, policy.timezone),
      owners: policies.map(owner => ({ ownerId: owner.ownerId, ownerName: owner.ownerName, shareBps: owner.shareBps })),
      ownerAmounts: policies.map(owner => ({ ownerId: owner.ownerId, amount: read(owner.allocation.owner) })) };
  });
  if (!total.equals(amount)) denied();
  return costs;
}
