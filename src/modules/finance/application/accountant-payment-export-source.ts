import { z } from "zod";
import { Temporal } from "temporal-polyfill";
import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { AccountantPaymentExportRepository, type AccountantPaymentPosting } from "../infrastructure/accountant-payment-export-repository";
import { accountantExportRow, AccountantExportSourceError, AccountantExportCapacityError, type AccountantExportColumn, type AccountantExportInput, type AccountantExportNativeSnapshot } from "../domain/accountant-export";
import { supplierPaymentAuditSchema } from "../domain/supplier-payment";
import { employeeCompensationSettlementAuditSchema } from "../domain/employee-compensation-settlement";
import { assertFinancePostingsBalanced } from "../domain/reservation-revenue";

const columns: AccountantExportColumn[] = ["recordType", "sourceId", "transactionId", "postingId", "reference", "occurredAt", "description", "currency", "accountId", "accountCode", "accountType", "normalSide", "side", "amount", "bucket", "supplierId", "invoiceId", "personId", "claimId", "reversesTransactionId", "paidAt", "paymentReference", "recognitionId", "submissionId", "invoiceNumber", "counterparty"];
const fail = (): never => { throw new AccountantExportSourceError(); };
const dimensions = z.record(z.string(), z.unknown());
const reversalReceipt = z.object({ originalTransactionIds: z.array(z.uuid()), reversalTransactionIds: z.array(z.uuid()) }).passthrough();
function groups(rows: AccountantPaymentPosting[]) {
  const map = new Map<string, AccountantPaymentPosting[]>();
  for (const row of rows) { const list = map.get(row.transactionId) ?? []; list.push(row); map.set(row.transactionId, list); } return map;
}

/** Original payment receipts identify the immutable claim; later claim corrections never erase paid or reversed history. */
export async function captureAccountantPaymentSource(tx: TenantTransaction, organizationId: string, input: AccountantExportInput,
  range: { startsAt: Date; endsAt: Date; maxRows: number }): Promise<AccountantExportNativeSnapshot> {
  if (input.kind !== "SUPPLIER_PAYMENTS" && input.kind !== "STAFF_PAYMENTS" || input.propertyId) return fail();
  const kind = input.kind, supplier = kind === "SUPPLIER_PAYMENTS", repository = new AccountantPaymentExportRepository(tx, organizationId), scope = { ...range, currency: input.currency };
  const source = await repository.postings(kind, scope); if (source.length > range.maxRows) throw new AccountantExportCapacityError();
  if (!source.length) return { columns, rows: [], fingerprint: commandFingerprint({ scope, source }) };
  const originalIds = [...new Set(source.map(row => row.reversesTransactionId ?? row.transactionId))].sort();
  // Each native settlement has exactly two legs, including originals outside the selected period.
  const originals = await repository.postings(kind, { ...scope, maxRows: originalIds.length * 2 }, originalIds), byOriginal = groups(originals), current = groups(source);
  if (originals.length !== originalIds.length * 2) return fail();
  const audits = await repository.audits(originalIds, kind), receipts = new Map<string, z.infer<typeof supplierPaymentAuditSchema> | z.infer<typeof employeeCompensationSettlementAuditSchema>>();
  const postedEvents = new Map<string, typeof audits>(), reversedEvents = new Map<string, typeof audits>();
  for (const event of audits) {
    if (!event.resourceId) return fail(); const index = event.action.endsWith(".posted") ? postedEvents : reversedEvents;
    const events = index.get(event.resourceId) ?? []; events.push(event); index.set(event.resourceId, events);
  }
  for (const id of originalIds) {
    const events = postedEvents.get(id) ?? []; if (events.length !== 1) return fail();
    const event = events[0], parsed = supplier ? supplierPaymentAuditSchema.safeParse(event.after) : employeeCompensationSettlementAuditSchema.safeParse(event.after);
    if (!parsed.success || parsed.data.transactionId !== id || event.reason !== parsed.data.input.reason) return fail();
    const legs = byOriginal.get(id)!; if (legs.some(row => !row.sealed || row.reversesTransactionId || row.createdBy !== event.actorId || Temporal.Instant.compare(row.occurredAt, parsed.data.postedAt) !== 0)) return fail();
    receipts.set(id, parsed.data);
  }
  const recognitionIds = [...new Set([...receipts.values()].map(receipt => receipt.recognitionId))].sort();
  const suppliers = supplier ? await repository.supplierRecognitions(recognitionIds) : [], staff = supplier ? [] : await repository.staffRecognitions(recognitionIds);
  const supplierSources = new Map(suppliers.map(row => [row.id, row])), staffSources = new Map(staff.map(row => [row.id, row]));
  const rows = [...current.entries()].flatMap(([id, legs]) => {
    const originalId = legs[0].reversesTransactionId ?? id, receipt = receipts.get(originalId) ?? fail(), payment = receipt.input;
    const supplierSource = supplierSources.get(receipt.recognitionId), staffSource = staffSources.get(receipt.recognitionId);
    const staffInput = "kind" in payment ? payment : null, offset = staffInput?.kind === "WALLET_OFFSET";
    const bucket = supplier ? "SUPPLIER_PAYMENT" : offset ? "COMPENSATION_OFFSET" : "EMPLOYEE_PAYMENT";
    if (supplier ? !supplierSource || supplierSource.invoiceId !== payment.id || supplierSource.submission.invoiceId !== payment.id || supplierSource.submission.revision.invoiceId !== payment.id || supplierSource.submission.revision.currency !== input.currency
      : !staffSource || !staffInput || staffSource.claimId !== staffInput.claimId || staffSource.submissionId !== payment.id || staffSource.claim.submissionId !== payment.id) return fail();
    const original = byOriginal.get(originalId)!, reversal = id !== originalId;
    if (legs.length !== 2 || original.length !== 2 || payment.currency !== input.currency) return fail();
    const amount = Money.of(payment.amount, input.currency), originalFunding = original.find(row => row.accountId === payment.fundingAccountId), originalClaim = original.find(row => row.accountId !== payment.fundingAccountId);
    if (!originalFunding || !originalClaim || originalFunding.side !== "CREDIT" || originalClaim.side !== "DEBIT" || originalClaim.accountType !== "CLAIM_OWNERSHIP" || originalClaim.normalSide !== "CREDIT" || originalClaim.accountCode !== (supplier ? "SUPPLIER_PAYABLE" : "EMPLOYEE_PAYABLE")) return fail();
    if (!["ASSET", "ASSET_LOCATION", "STAFF_WALLET"].includes(originalFunding.accountType) || originalFunding.normalSide !== "DEBIT" || originalFunding.accountCode.startsWith("CASH_CUSTODY_")) return fail();
    for (const row of [...original, ...legs]) {
      if (!row.sealed || row.currency !== input.currency || row.bucket !== bucket || !Money.of(row.amount, input.currency).equals(amount)) return fail();
      const parsed = dimensions.safeParse(row.dimensions); if (!parsed.success) return fail(); const facts = parsed.data;
      if (supplier ? facts.supplier_id !== supplierSource!.invoice.supplierId || facts.supplier_invoice_id !== payment.id || facts.supplier_payment_id !== payment.idempotencyKey || facts.source !== "SUPPLIER_PAYMENT"
        : facts.employee_person_id !== staffSource!.claim.personId || facts.employee_compensation_claim_id !== staffSource!.claimId || facts[offset ? "employee_compensation_offset_id" : "employee_compensation_payment_id"] !== payment.idempotencyKey || facts.source !== (offset ? "EMPLOYEE_COMPENSATION_OFFSET" : "EMPLOYEE_PAYMENT")) return fail();
    }
    if (reversal) {
      const reversalEvents = (reversedEvents.get(originalId) ?? []).filter(event => reversalReceipt.safeParse(event.after).success);
      if (reversalEvents.length !== 1) return fail(); const event = reversalReceipt.parse(reversalEvents[0].after);
      if (!event.originalTransactionIds.includes(originalId) || !event.reversalTransactionIds.includes(id)) return fail();
      for (const row of legs) { const originalRow = original.find(value => value.accountId === row.accountId); if (!originalRow || row.side === originalRow.side || commandFingerprint(row.dimensions) !== commandFingerprint(originalRow.dimensions)) return fail(); }
    }
    assertFinancePostingsBalanced(legs.map(row => ({ ledgerAccountId: row.accountId, side: row.side, amount: Money.of(row.amount, row.currency), bucket: row.bucket!, dimensions: dimensions.parse(row.dimensions) })));
    return legs.map(row => accountantExportRow(row.id, columns, { recordType: (supplier ? "SUPPLIER_PAYMENT" : offset ? "STAFF_WALLET_OFFSET" : "STAFF_PAYMENT") + (reversal ? "_REVERSAL" : ""),
      sourceId: originalId, transactionId: id, postingId: row.id, reference: row.reference, occurredAt: row.occurredAt, description: row.description,
      currency: row.currency, accountId: row.accountId, accountCode: row.accountCode, accountType: row.accountType, normalSide: row.normalSide, side: row.side, amount: Money.of(row.amount, row.currency).toJSON().amount,
      bucket: row.bucket, supplierId: supplierSource?.invoice.supplierId ?? null, invoiceId: supplierSource?.invoiceId ?? null, personId: staffSource?.claim.personId ?? null, claimId: staffSource?.claimId ?? null,
      reversesTransactionId: row.reversesTransactionId, paidAt: payment.paidAt, paymentReference: payment.reference, recognitionId: receipt.recognitionId,
      submissionId: supplierSource?.submissionId ?? staffSource?.submissionId ?? null, invoiceNumber: supplierSource?.submission.revision.invoiceNumber ?? null,
      counterparty: supplierSource?.invoice.supplier.displayName ?? staffSource?.claim.person.displayName ?? fail() }));
  });
  return { columns, rows, fingerprint: commandFingerprint({ scope, source, originals, audits, suppliers, staff }) };
}
