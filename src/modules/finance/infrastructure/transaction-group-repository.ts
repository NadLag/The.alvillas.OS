import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { FinanceRepository } from "./finance-repository";
import { groupedAccountMovements } from "../domain/transaction-group";

export class TransactionGroupRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async lockRequest(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":transaction-group-request:" + key},0))::text`);
  }
  async lockTransaction(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":transaction-group:" + id},0))::text`);
  }
  clock() { return new FinanceRepository(this.tx, this.organizationId).clock(); }
  group(id: string) {
    return this.tx.transactionGroup.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } },
      include: { creator: { select: { person: { select: { displayName: true } } } } } });
  }
  groupByKey(idempotencyKey: string) {
    return this.tx.transactionGroup.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } } });
  }
  entryByKey(idempotencyKey: string) {
    return this.tx.transactionGroupEntry.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } } });
  }
  currentEntry(transactionId: string) {
    return this.tx.transactionGroupEntry.findFirst({ where: { organizationId: this.organizationId, transactionId, nextEntry: null } });
  }
  transaction(id: string) {
    return this.tx.financialTransaction.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } }, select: { id: true } });
  }
  createGroup(input: { name: string; reason: string; idempotencyKey: string; createdBy: string }) {
    return this.tx.transactionGroup.create({ data: { organizationId: this.organizationId, ...input } });
  }
  createEntry(input: { groupId: string; transactionId: string; previousEntryId: string | null; action: string; reason: string; idempotencyKey: string; createdBy: string }) {
    return this.tx.transactionGroupEntry.create({ data: { organizationId: this.organizationId, ...input } });
  }
  list(input: { after?: string; query?: string }) {
    return this.tx.transactionGroup.findMany({ where: { organizationId: this.organizationId,
      ...(input.after ? { id: { gt: input.after } } : {}), ...(input.query ? { name: { contains: input.query, mode: "insensitive" as const } } : {}) },
      orderBy: { id: "asc" }, take: 51, include: { _count: { select: { entries: { where: { action: "ATTACH", nextEntry: null } } } } } });
  }
  members(groupId: string, after?: string) {
    return this.tx.transactionGroupEntry.findMany({ where: { organizationId: this.organizationId, groupId, action: "ATTACH", nextEntry: null,
      ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 51,
      include: { transaction: { select: { id: true, reference: true, occurredAt: true, description: true,
        postings: { select: { id: true, side: true, amount: true, currency: true, bucket: true,
          ledgerAccount: { select: { name: true, accountType: true } } } } } } } });
  }
  async history(groupId: string, after?: string) {
    // Keep PostgreSQL timestamp precision at page boundaries.
    const ids = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM transaction_group_entry
      WHERE organization_id=${this.organizationId}::uuid AND group_id=${groupId}::uuid
      ${after ? Prisma.sql`AND (created_at,id)<(SELECT created_at,id FROM transaction_group_entry
        WHERE organization_id=${this.organizationId}::uuid AND group_id=${groupId}::uuid AND id=${after}::uuid)` : Prisma.empty}
      ORDER BY created_at DESC,id DESC LIMIT 51`);
    return this.tx.transactionGroupEntry.findMany({ where: { organizationId: this.organizationId, groupId, id: { in: ids.map(row => row.id) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51, include: {
        transaction: { select: { reference: true } }, creator: { select: { person: { select: { displayName: true } } } } } });
  }
  candidates(input: { after?: string; query?: string }) {
    return this.tx.financialTransaction.findMany({ where: { organizationId: this.organizationId,
      groupEntries: { none: { action: "ATTACH", nextEntry: null } },
      ...(input.after ? { id: { gt: input.after } } : {}), ...(input.query ? { OR: [
        { reference: { contains: input.query, mode: "insensitive" as const } }, { description: { contains: input.query, mode: "insensitive" as const } }
      ] } : {}) }, orderBy: { id: "asc" }, take: 51,
      select: { id: true, reference: true, occurredAt: true, description: true,
        groupEntries: { where: { nextEntry: null }, select: { id: true } } } });
  }
  async movements(groupId: string) {
    const amounts = await this.tx.posting.groupBy({ by: ["ledgerAccountId", "side", "currency"],
      where: { organizationId: this.organizationId, transaction: { groupEntries: { some: { groupId, action: "ATTACH", nextEntry: null } } } }, _sum: { amount: true } });
    const accounts = new Map((await this.tx.ledgerAccount.findMany({ where: { organizationId: this.organizationId,
      id: { in: [...new Set(amounts.map(row => row.ledgerAccountId))] } }, select: { id: true, name: true, accountType: true, normalSide: true } })).map(row => [row.id, row]));
    return groupedAccountMovements(amounts.map(row => {
      const account = accounts.get(row.ledgerAccountId);
      if (!account || row._sum.amount === null) throw Error("Grouped movement source is unavailable");
      return { ledgerAccountId: row.ledgerAccountId, side: row.side, currency: row.currency, amount: row._sum.amount.toString(), account };
    }));
  }
}
