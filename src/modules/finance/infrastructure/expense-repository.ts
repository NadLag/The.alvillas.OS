import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { ExpenseDraftInput } from "../domain/expense";

const include = { property: { select: { id: true, name: true, city: true, cityId: true, region: true, regionId: true, timezone: true, archivedAt: true } },
  submission: true, approval: { include: { financialStages: { orderBy: { position: "asc" as const }, include: { recipients: true } } } } } satisfies Prisma.ExpenseInclude;
function draftFacts(input: ExpenseDraftInput) {
  return { propertyId: input.propertyId, reservationId: input.reservationId ?? null, fundingAccountId: input.fundingAccountId,
    amount: input.amount, currency: input.currency, category: input.category, purpose: input.purpose, emergency: input.emergency,
    occurredOn: new Date(`${input.occurredOn}T00:00:00.000Z`) };
}
export class ExpenseRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async clock() {
    const [clock] = await this.tx.$queryRaw<Array<{ now: Date; id: string }>>(Prisma.sql`SELECT date_trunc('milliseconds',clock_timestamp()) AS now, app_uuid_v7()::text AS id`);
    return clock;
  }
  async lock(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":expense:" + key},0))::text`);
  }
  find(id: string) { return this.tx.expense.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  byKey(idempotencyKey: string) { return this.tx.expense.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include }); }
  property(id: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null },
      select: { id: true, name: true, city: true, cityId: true, region: true, regionId: true, timezone: true } });
  }
  reservation(id: string) { return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, select: { id: true, propertyId: true, source: true, reference: true } }); }
  currency(code: string) { return this.tx.currency.findUnique({ where: { code }, select: { code: true, minorUnit: true } }); }
  async editorSources() {
    const [organization, currencies] = await Promise.all([
      this.tx.organization.findUniqueOrThrow({ where: { id: this.organizationId }, select: { baseCurrency: true } }),
      this.tx.currency.findMany({ where: { minorUnit: { lte: 2 } }, select: { code: true, minorUnit: true }, orderBy: { code: "asc" } })
    ]);
    return { baseCurrency: organization.baseCurrency, currencies };
  }
  reservationChoices(propertyId: string) {
    return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null },
      select: { id: true, reference: true, status: true, createdBy: true }, orderBy: [{ checkIn: "desc" }, { id: "desc" }], take: 100 });
  }
  async sourceOwners(propertyId: string, reservationId: string | undefined) {
    const snapshot = reservationId ? await this.tx.reservationFinancialSnapshot.findFirst({ where: { organizationId: this.organizationId, reservationId,
      rules: { path: ["owners"], array_contains: [] } }, orderBy: { version: "asc" }, select: { id: true, version: true, rules: true } }) : null;
    const owners = await this.tx.propertyOwner.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null, owner: { archivedAt: null } },
      select: { ownerId: true, shareBps: true, owner: { select: { displayName: true } } }, orderBy: { ownerId: "asc" } });
    const commissionSnapshots = reservationId ? await this.tx.commissionSnapshot.findMany({ where: { organizationId: this.organizationId, reservationId }, orderBy: { ownerId: "asc" } }) : [];
    return { snapshot, commissionSnapshots, owners: owners.map(row => ({ ownerId: row.ownerId, ownerName: row.owner.displayName, shareBps: row.shareBps })) };
  }
  async periodRevenue(input: { propertyId: string; currency: string; startsAt?: Date; endsAt?: Date; reservationId?: string }) {
    const [row] = await this.tx.$queryRaw<Array<{ amount: Prisma.Decimal }>>(Prisma.sql`SELECT COALESCE(SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) AS amount
      FROM posting p JOIN financial_transaction t ON t.id=p.transaction_id AND t.organization_id=p.organization_id
      JOIN ledger_account a ON a.id=p.ledger_account_id AND a.organization_id=p.organization_id
      WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency} AND p.bucket='OWNER_REVENUE'
        AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT'
        AND p.dimensions->>'property_id'=${input.propertyId}
        ${input.reservationId ? Prisma.sql`AND p.dimensions->>'reservation_id'=${input.reservationId}` : Prisma.empty}
        ${input.startsAt ? Prisma.sql`AND t.occurred_at >= ${input.startsAt}` : Prisma.empty}
        ${input.endsAt ? Prisma.sql`AND t.occurred_at < ${input.endsAt}` : Prisma.empty}`);
    return row.amount.toString();
  }
  event(type: "ExpenseSubmitted" | "ExpenseOverThreshold", expenseId: string, payload: Prisma.InputJsonObject, occurredAt: Date) {
    const idempotencyKey = `expense:${expenseId}:${type}`;
    return this.tx.outboxEvent.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, update: {},
      create: { organizationId: this.organizationId, type, payload, idempotencyKey, occurredAt } });
  }
  agreement(propertyId: string, asOf: Date) {
    return this.tx.managementAgreement.findFirst({ where: { organizationId: this.organizationId, propertyId, archivedAt: null, status: { not: "DRAFT" },
      effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] }, orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      select: { id: true, reference: true, effectiveFrom: true, effectiveTo: true, createdAt: true, updatedAt: true } });
  }
  create(id: string, input: ExpenseDraftInput, actorId: string) {
    return this.tx.expense.create({ data: { ...draftFacts(input), idempotencyKey: input.idempotencyKey, organizationId: this.organizationId, id,
      createdBy: actorId, updatedBy: actorId }, include });
  }
  updateDraft(id: string, version: number, input: ExpenseDraftInput, actorId: string) {
    return this.tx.expense.updateMany({ where: { organizationId: this.organizationId, id, version, state: "DRAFT" },
      data: { ...draftFacts(input), updatedBy: actorId, version: { increment: 1 } } });
  }
  transition(id: string, version: number, previous: string, state: string, actorId: string, transactionId?: string) {
    return this.tx.expense.updateMany({ where: { organizationId: this.organizationId, id, version, state: previous },
      data: { state, updatedBy: actorId, version: { increment: 1 }, ...(transactionId ? { transactionId } : {}) } });
  }
  submit(expenseId: string, submittedBy: string, snapshot: Prisma.InputJsonObject, submittedAt: Date) {
    return this.tx.expenseSubmission.create({ data: { organizationId: this.organizationId, expenseId, submittedBy, snapshot, submittedAt } });
  }
  page(after?: { at: Date; id: string }) {
    return this.tx.expense.findMany({ where: { organizationId: this.organizationId, ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, include });
  }
}
export type ExpenseRecord = NonNullable<Awaited<ReturnType<ExpenseRepository["find"]>>>;
