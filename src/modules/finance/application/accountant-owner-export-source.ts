import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { buildOwnerStatement } from "@/platform/ledger/owner-statement";
import { OwnerStatementRepository } from "@/platform/ledger/owner-statement-repository";
import { AccountantPostingExportRepository } from "../infrastructure/accountant-posting-export-repository";
import { accountantExportRow, AccountantExportAccessError, AccountantExportSourceError, type AccountantExportInput, type AccountantExportColumn, type AccountantExportNativeSnapshot } from "../domain/accountant-export";

const columns: AccountantExportColumn[] = ["recordType", "sourceId", "transactionId", "postingId", "reference", "occurredAt", "description", "currency", "side", "amount", "bucket", "propertyId", "ownerId", "opening", "debits", "credits", "closing"];

/** The original statement builder remains the only balance implementation. Its complete underlying movement history fences the export. */
export async function captureAccountantOwnerSource(tx: TenantTransaction, organizationId: string, input: AccountantExportInput,
  range: { startsAt: Date; endsAt: Date }): Promise<AccountantExportNativeSnapshot> {
  if (!input.ownerId) throw new AccountantExportSourceError();
  const repository = new AccountantPostingExportRepository(tx, organizationId), owner = await repository.owner(input.ownerId), property = input.propertyId ? await repository.property(input.propertyId) : null;
  if (!owner || input.propertyId && !property) throw new AccountantExportAccessError();
  const postings = await new OwnerStatementRepository(tx, organizationId).listOwnerLedgerPostings({ ownerId: owner.id, propertyId: input.propertyId,
    periodEnd: range.endsAt, currency: input.currency, includeLocations: false });
  const statement = buildOwnerStatement({ organizationId, ownerId: owner.id, ownerName: owner.displayName, propertyId: input.propertyId ?? null,
    propertyName: property?.name ?? null, periodStart: range.startsAt, periodEnd: range.endsAt, currency: input.currency, postings });
  const rows = [accountantExportRow("owner-summary:" + owner.id, columns, { recordType: "OWNER_SUMMARY", sourceId: owner.id, transactionId: null, postingId: null,
    reference: owner.id, occurredAt: null, description: owner.displayName, currency: input.currency, side: null, amount: null, bucket: null, propertyId: input.propertyId ?? null,
    ownerId: owner.id, opening: statement.openingBalance.toJSON().amount, debits: statement.periodDebitTotal.toJSON().amount,
    credits: statement.periodCreditTotal.toJSON().amount, closing: statement.closingBalance.toJSON().amount })];
  const originals = new Map(postings.map(posting => [posting.id, posting]));
  for (const line of statement.lines) {
    const original = originals.get(line.postingId); if (!original?.occurredAtIso) throw new AccountantExportSourceError();
    rows.push(accountantExportRow(line.postingId, columns, { recordType: "OWNER_MOVEMENT", sourceId: line.postingId, transactionId: line.transactionId, postingId: line.postingId,
      reference: line.reference, occurredAt: original.occurredAtIso, description: line.description, currency: input.currency, side: line.side, amount: line.amount.toJSON().amount,
      bucket: line.bucket, propertyId: line.propertyId, ownerId: owner.id, opening: null, debits: null, credits: null, closing: null }));
  }
  return { columns, rows, fingerprint: commandFingerprint({ owner, property, postings, range }) };
}
