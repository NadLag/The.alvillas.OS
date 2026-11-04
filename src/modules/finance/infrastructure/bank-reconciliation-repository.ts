import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { BankSourceFact } from "../domain/bank-statement-source-state";

export class BankReconciliationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  request(actorId: string, idempotencyKey: string) {
    return this.tx.bankReconciliationEntry.findFirst({ where: { organizationId: this.organizationId, actorId, idempotencyKey }, include: { allocations: true, release: true } });
  }
  requestKey(actorId: string, id: string) {
    return this.tx.bankReconciliationEntry.findFirst({ where: { organizationId: this.organizationId, actorId, id }, select: { idempotencyKey: true } });
  }
  knownBankAccount(accountId: string) {
    return this.tx.bankStatementAdmission.findFirst({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, import: { isNot: null } }, select: { id: true } });
  }
  entry(id: string) {
    return this.tx.bankReconciliationEntry.findFirst({ where: { organizationId: this.organizationId, id }, include: { allocations: true, release: true } });
  }
  postings(accountId: string, ids: string[]) {
    // Only the selected bank leg is projected; opposing owner and payroll postings are private.
    return this.tx.posting.findMany({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, id: { in: ids }, transaction: { sealed: true } },
      select: { id: true, amount: true, side: true, currency: true, transactionId: true, transaction: { select: { id: true, reference: true, occurredAt: true,
        reversedByTransactions: { select: { id: true }, orderBy: { id: "asc" } } } } }, orderBy: { id: "asc" } });
  }
  lines(accountId: string, ids: string[]) {
    return this.tx.bankStatementLine.findMany({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, id: { in: ids } }, orderBy: { id: "asc" } });
  }
  sourcePage(accountId: string, currency: string, after?: string) {
    return this.tx.bankStatementLine.findMany({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, currency, ...(after ? { id: { lt: after } } : {}) }, orderBy: { id: "desc" }, take: 51 });
  }
  postingPage(accountId: string, currency: string, after?: string) {
    return this.tx.posting.findMany({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, currency, transaction: { sealed: true }, ...(after ? { id: { lt: after } } : {}) },
      select: { id: true, amount: true, side: true, currency: true, transactionId: true, transaction: { select: { id: true, reference: true, occurredAt: true,
        reversedByTransactions: { select: { id: true }, orderBy: { id: "asc" } } } } }, orderBy: { id: "desc" }, take: 51 });
  }
  history(accountId: string, before?: string) {
    const allocations = { select: { postingId: true } } as const;
    return this.tx.bankReconciliationEntry.findMany({ where: { organizationId: this.organizationId, ledgerAccountId: accountId, ...(before ? { id: { lt: before } } : {}) },
      include: { allocations, previous: { select: { allocations } } }, orderBy: { id: "desc" }, take: 51 });
  }
  async states(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.tx.$queryRaw<Array<{ id: string; state: string }>>(Prisma.sql`SELECT e.id,CASE
      WHEN e.action='RELEASE' OR EXISTS(SELECT 1 FROM bank_reconciliation_entry released WHERE released.organization_id=e.organization_id AND released.previous_entry_id=e.id) THEN 'RELEASED'
      WHEN EXISTS(SELECT 1 FROM bank_reconciliation_allocation a WHERE a.organization_id=e.organization_id AND a.entry_id=e.id AND (
        (a.line_id IS NOT NULL AND NOT app_bank_statement_line_is_current(e.organization_id,a.line_id)) OR
        (a.posting_id IS NOT NULL AND a.source_snapshot->'reversalIds' IS DISTINCT FROM
          (SELECT COALESCE(jsonb_agg(r.id::text ORDER BY r.id),'[]'::jsonb) FROM posting p JOIN financial_transaction r ON r.organization_id=p.organization_id AND r.reverses_transaction_id=p.transaction_id
           WHERE p.organization_id=e.organization_id AND p.id=a.posting_id)))) THEN 'SOURCE_CHANGED'
      WHEN (e.snapshot->>'variance')::numeric<>0 THEN 'OPEN_VARIANCE' ELSE 'MATCHED' END AS state
      FROM bank_reconciliation_entry e WHERE e.organization_id=${this.organizationId}::uuid AND e.id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})`);
    return new Map(rows.map(row => [row.id, row.state]));
  }
  async families(ids: string[]) {
    if (!ids.length) return [];
    return this.tx.$queryRaw<BankSourceFact[]>(Prisma.sql`WITH RECURSIVE family AS (
      SELECT id,ledger_account_id,bank_identity_hash,currency,external_id,corrects_external_id,correction_action FROM bank_statement_line
      WHERE organization_id=${this.organizationId}::uuid AND id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      UNION
      SELECT l.id,l.ledger_account_id,l.bank_identity_hash,l.currency,l.external_id,l.corrects_external_id,l.correction_action
      FROM bank_statement_line l JOIN family f ON l.ledger_account_id=f.ledger_account_id AND l.bank_identity_hash=f.bank_identity_hash
        AND (l.external_id=f.corrects_external_id OR l.corrects_external_id=f.external_id)
      WHERE l.organization_id=${this.organizationId}::uuid
    ) SELECT id,ledger_account_id AS "ledgerAccountId",bank_identity_hash AS "bankIdentityHash",currency,
      external_id AS "externalId",corrects_external_id AS "correctsExternalId",correction_action AS "correctionAction" FROM family`);
  }
  async allocated(postingIds: string[], lineIds: string[]) {
    const rows = await this.tx.bankReconciliationAllocation.groupBy({ by: ["postingId", "lineId"], where: { organizationId: this.organizationId,
      OR: [{ postingId: { in: postingIds } }, { lineId: { in: lineIds } }], entry: { action: "MATCH", release: null } }, _sum: { amount: true } });
    return new Map(rows.map(row => [(row.postingId ? "EXPECTED:" + row.postingId : "ACTUAL:" + row.lineId), row._sum.amount!.toFixed(2)]));
  }
  create(data: Omit<Prisma.BankReconciliationEntryUncheckedCreateInput, "organizationId">) {
    return this.tx.bankReconciliationEntry.create({ data: { ...data, organizationId: this.organizationId } });
  }
  allocate(entryId: string, rows: Omit<Prisma.BankReconciliationAllocationCreateManyInput, "organizationId" | "entryId">[]) {
    return this.tx.bankReconciliationAllocation.createMany({ data: rows.map(row => ({ ...row, entryId, organizationId: this.organizationId })) });
  }
  async flush() { await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`); }
}
