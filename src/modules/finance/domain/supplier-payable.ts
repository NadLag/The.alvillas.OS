import { Money } from "@/platform/money/money";
import { expensePostings, isExpenseFundingAccount } from "./expense";
import { assertFinancePostingsBalanced, type FinancePostingDraft, type PropertyOwnerShare } from "./reservation-revenue";
import type { ConfiguredExpenseAllocation } from "./configured-finance-rules";

export type SupplierInvoicePostingLine = {
  id: string;
  propertyId?: string | null;
  reservationId?: string | null;
  category: string;
  costCenter?: string | null;
  amount: Money;
  allocation: Pick<ConfiguredExpenseAllocation, "ownerAmount" | "alvillasAmount" | "guestAmount">;
  owners: readonly PropertyOwnerShare[];
  ownerAmounts: ReadonlyArray<{ ownerId: string; amount: Money }>;
  ownerAccounts: ReadonlyMap<string, string>;
  companyExpenseAccountId: string;
  guestReceivableAccountId: string;
};

/** Invoice recognition credits the supplier claim without moving a physical account. */
export function supplierInvoicePostings(input: {
  invoiceId: string; supplierId: string; liabilityAccountId: string; amount: Money; lines: readonly SupplierInvoicePostingLine[];
}): FinancePostingDraft[] {
  if (!input.lines.length || !input.amount.amount.gt(0)) throw Error("A supplier invoice requires positive allocated money");
  const seen = new Set<string>();
  let allocated = Money.zero(input.amount.currency);
  const postings = input.lines.flatMap(line => {
    if (seen.has(line.id)) throw Error("Supplier invoice allocation identities must be distinct");
    seen.add(line.id);
    if (!line.propertyId && (line.reservationId || line.allocation.ownerAmount.amount.gt(0) || line.allocation.guestAmount.amount.gt(0))) throw Error("Property and guest allocations require their property source");
    if (line.allocation.guestAmount.amount.gt(0) && !line.reservationId) throw Error("Guest allocations require their reservation source");
    allocated = allocated.add(line.amount);
    const dimensions = { supplier_id: input.supplierId, supplier_invoice_id: input.invoiceId, supplier_invoice_line_id: line.id,
      ...(line.propertyId ? { property_id: line.propertyId } : {}), ...(line.reservationId ? { reservation_id: line.reservationId } : {}),
      category: line.category, ...(line.costCenter ? { cost_center: line.costCenter } : {}), source: "SUPPLIER_INVOICE" };
    return expensePostings({ ...line, fundingAccountId: input.liabilityAccountId, dimensions }).map(posting =>
      posting.ledgerAccountId === input.liabilityAccountId ? { ...posting, bucket: "SUPPLIER_INVOICE" } : posting);
  });
  if (!allocated.equals(input.amount)) throw Error("Supplier invoice allocations must conserve the invoice total");
  assertFinancePostingsBalanced(postings);
  return postings;
}

/** Payment settles the existing claim; it never books the expense a second time. */
export function supplierPaymentPostings(input: {
  invoiceId: string; supplierId: string; paymentId: string; liabilityAccountId: string; amount: Money; outstanding: Money;
  funding: Parameters<typeof isExpenseFundingAccount>[0] & { id: string };
}): FinancePostingDraft[] {
  if (input.amount.currency !== input.outstanding.currency || !input.amount.amount.gt(0) || !input.outstanding.amount.gt(0) || input.amount.amount.gt(input.outstanding.amount)) throw Error("Supplier payment must settle positive outstanding money in one currency");
  if (!isExpenseFundingAccount(input.funding) || input.funding.id === input.liabilityAccountId) throw Error("Supplier payment requires a distinct available physical funding account");
  const dimensions = { supplier_id: input.supplierId, supplier_invoice_id: input.invoiceId, supplier_payment_id: input.paymentId, source: "SUPPLIER_PAYMENT" };
  const postings: FinancePostingDraft[] = [
    { ledgerAccountId: input.liabilityAccountId, side: "DEBIT", amount: input.amount, bucket: "SUPPLIER_PAYMENT", dimensions },
    { ledgerAccountId: input.funding.id, side: "CREDIT", amount: input.amount, bucket: "SUPPLIER_PAYMENT", dimensions }
  ];
  assertFinancePostingsBalanced(postings);
  return postings;
}

/** All original and reversing claim movements contribute; no editable balance is stored. */
export function supplierOutstanding(currency: string, movements: ReadonlyArray<{ side: "DEBIT" | "CREDIT"; amount: Money }>): Money {
  return movements.reduce((balance, movement) => movement.side === "CREDIT" ? balance.add(movement.amount) : balance.subtract(movement.amount), Money.zero(currency));
}
