import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { bankStatementLineIdentity, BankStatementConflictError, type ParsedBankStatement } from "../domain/bank-statement-import";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export class BankStatementRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  account(id: string) {
    return this.tx.ledgerAccount.findFirst({ where: { organizationId: this.organizationId, id }, include: { teamWallet: { select: { id: true, personId: true, person: { select: { archivedAt: true } } } } } });
  }
  admission(actorId: string, idempotencyKey: string) {
    return this.tx.bankStatementAdmission.findFirst({ where: { organizationId: this.organizationId, actorId, idempotencyKey }, include: { import: { include: { _count: { select: { originalLines: true } } } } } });
  }
  admissionById(actorId: string, id: string) {
    return this.tx.bankStatementAdmission.findFirst({ where: { organizationId: this.organizationId, actorId, id }, select: { idempotencyKey: true } });
  }
  accounts(codes: string[]) {
    return this.tx.ledgerAccount.findMany({ where: { organizationId: this.organizationId, code: { in: codes }, archivedAt: null, accountType: "ASSET_LOCATION", normalSide: "DEBIT", teamWallet: null }, orderBy: { id: "asc" } });
  }
  async historyAccounts() {
    const latest = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT DISTINCT ON (a.ledger_account_id) a.id FROM bank_statement_admission a
      WHERE a.organization_id=${this.organizationId}::uuid AND EXISTS(SELECT 1 FROM bank_statement_import i WHERE i.organization_id=a.organization_id AND i.admission_id=a.id)
      ORDER BY a.ledger_account_id,a.created_at DESC,a.id DESC`);
    return this.tx.bankStatementAdmission.findMany({ where: { organizationId: this.organizationId, id: { in: latest.map(row => row.id) } }, include: { ledgerAccount: true } });
  }
  list(accountId: string, before?: string) {
    return this.tx.bankStatementImport.findMany({ where: { organizationId: this.organizationId, admission: { ledgerAccountId: accountId }, ...(before ? { id: { lt: before } } : {}) }, include: { admission: true, _count: { select: { originalLines: true } } }, orderBy: { id: "desc" }, take: 51 });
  }
  imported(id: string) {
    return this.tx.bankStatementImport.findFirst({ where: { organizationId: this.organizationId, id }, include: { admission: true, _count: { select: { originalLines: true } } } });
  }
  evidence(importId: string, afterOrder = 0) {
    return this.tx.bankStatementEvidence.findMany({ where: { organizationId: this.organizationId, importId, sourceOrder: { gt: afterOrder } }, include: { line: true }, orderBy: { sourceOrder: "asc" }, take: 51 });
  }
  facts(identityHashes: string[]) {
    return this.tx.bankStatementLine.findMany({ where: { organizationId: this.organizationId, identityHash: { in: identityHashes } } });
  }
  admit(data: Omit<Prisma.BankStatementAdmissionCreateManyInput, "organizationId">) {
    return this.tx.bankStatementAdmission.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async complete(admission: { id: string; ledgerAccountId: string; bankIdentityHash: string; fileSha256: string }, parsed: ParsedBankStatement, currency: string, normalizedHash: string) {
    const drafts = parsed.lines.map(({ sourceOrder, fact }) => ({ sourceOrder, fact,
      identityHash: bankStatementLineIdentity(admission.bankIdentityHash, admission.fileSha256, sourceOrder, fact.externalId), factHash: commandFingerprint(fact) }));
    if (new Set(drafts.map(draft => draft.identityHash)).size !== drafts.length) throw new BankStatementConflictError();
    const retained = await this.tx.bankStatementLine.findMany({ where: { organizationId: this.organizationId, identityHash: { in: drafts.map(draft => draft.identityHash) } } });
    const byIdentity = new Map(retained.map(line => [line.identityHash, line]));
    for (const draft of drafts) {
      const original = byIdentity.get(draft.identityHash);
      if (original && (original.factHash !== draft.factHash || original.ledgerAccountId !== admission.ledgerAccountId || original.currency !== currency)) throw new BankStatementConflictError();
    }
    const imported = await this.tx.bankStatementImport.create({ data: { organizationId: this.organizationId, admissionId: admission.id, normalizedHash,
      rowCount: drafts.length, statement: json(parsed.statement) } });
    const fresh = drafts.filter(draft => !byIdentity.has(draft.identityHash));
    if (fresh.length) await this.tx.bankStatementLine.createMany({ data: fresh.map(({ fact, identityHash, factHash }) => ({ organizationId: this.organizationId,
      originalImportId: imported.id, ledgerAccountId: admission.ledgerAccountId, identityHash, factHash, bankIdentityHash: admission.bankIdentityHash,
      externalId: fact.externalId, correctsExternalId: fact.correction?.externalId ?? null, correctionAction: fact.correction?.action ?? null,
      postedOn: fact.postedDate ? new Date(fact.postedDate + "T00:00:00.000Z") : null, amount: fact.amount?.amount ?? null, currency, source: json(fact) })) });
    const lines = fresh.length ? await this.tx.bankStatementLine.findMany({ where: { organizationId: this.organizationId, identityHash: { in: drafts.map(draft => draft.identityHash) } } }) : retained;
    const complete = new Map(lines.map(line => [line.identityHash, line.id]));
    if (complete.size !== drafts.length) throw new BankStatementConflictError();
    if (drafts.length) await this.tx.bankStatementEvidence.createMany({ data: drafts.map(draft => ({ organizationId: this.organizationId,
      importId: imported.id, lineId: complete.get(draft.identityHash)!, sourceOrder: draft.sourceOrder })) });
    return { ...imported, newRows: fresh.length, reusedRows: drafts.length - fresh.length };
  }
  async flush() { await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`); }
}
