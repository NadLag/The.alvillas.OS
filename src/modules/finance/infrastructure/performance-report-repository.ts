import { Prisma } from "@prisma/client";
import { OwnerStatementRepository } from "@/platform/ledger/owner-statement-repository";
import { CompanyLedgerRepository } from "./company-ledger-repository";
import { KpiMaterializationRepository } from "./kpi-materialization-repository";
import { KpiReportRepository } from "./kpi-report-repository";
import { InventoryReportRepository } from "./inventory-report-repository";
import { PropertyFinanceRepository } from "./property-finance-repository";
import type { CompanyPostingTotal, PortfolioNights, PropertyPostingTotal, TeamPerformanceSource } from "../domain/performance-report";

export class PerformanceReportRepository extends PropertyFinanceRepository {
  async materializedPortfolioNights(input: { fromOn: string; toOn: string; timezone: string }) {
    return await new KpiMaterializationRepository(this.tx, this.organizationId).lookup(input)
      ?? this.portfolioNights(input.fromOn, input.toOn);
  }

  kpi() {
    return new KpiReportRepository(this.tx, this.organizationId);
  }

  inventory() {
    return new InventoryReportRepository(this.tx, this.organizationId);
  }

  reportProperties() {
    return this.tx.property.findMany({ where: { organizationId: this.organizationId, archivedAt: null },
      select: { id: true, name: true, cityId: true, regionId: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  }

  propertyPostings(input: { propertyId: string | null; currency: string; startsAt: Date; endsAt: Date; ownerId?: string; bookingSource?: string }) {
    return this.tx.$queryRaw<PropertyPostingTotal[]>(Prisma.sql`
      WITH classified AS (
        SELECT CASE
          WHEN a.account_type = 'CLAIM_OWNERSHIP' AND a.code = 'OWNER_PAYABLE' THEN
            CASE p.bucket
              WHEN 'OWNER_REVENUE' THEN 'roomRevenue'
              WHEN 'OWNER_SERVICES' THEN 'ownerServiceRevenue'
              WHEN 'COMMISSION' THEN 'commission'
              WHEN 'OTA_FEE' THEN 'platformFees'
              WHEN 'OWNER_EXPENSE' THEN 'ownerExpenses'
              WHEN 'REIMBURSEMENT' THEN 'reimbursements'
            END
          WHEN a.account_type = 'ALVILLAS_OWN' AND a.code = 'ALVILLAS_SERVICE_REVENUE' THEN 'companyServiceRevenue'
          WHEN a.account_type = 'ALVILLAS_OWN' AND a.code = 'ALVILLAS_EXPENSE' THEN 'operatingCosts'
        END AS key, p.side, p.amount
        FROM posting p
        JOIN financial_transaction t ON t.organization_id = p.organization_id AND t.id = p.transaction_id
        JOIN ledger_account a ON a.organization_id = p.organization_id AND a.id = p.ledger_account_id
        LEFT JOIN cash_collection cash ON cash.organization_id = p.organization_id
          AND cash.transaction_id = coalesce(t.reverses_transaction_id,t.id)
        WHERE p.organization_id = ${this.organizationId}::uuid AND p.currency = ${input.currency}
          ${input.propertyId ? Prisma.sql`AND coalesce(cash.property_id::text,p.dimensions->>'property_id')=${input.propertyId}` : Prisma.empty}
          ${input.ownerId ? Prisma.sql`AND p.dimensions->>'owner_id'=${input.ownerId}` : Prisma.empty}
          ${input.bookingSource ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM reservation r WHERE r.organization_id=p.organization_id
              AND r.id::text=coalesce(cash.reservation_id::text,p.dimensions->>'reservation_id') AND r.source=${input.bookingSource})` : Prisma.empty}
          AND t.sealed AND t.occurred_at >= ${input.startsAt} AND t.occurred_at < ${input.endsAt}
      )
      SELECT key, sum(CASE WHEN (side = 'DEBIT') = (key IN ('commission', 'platformFees', 'ownerExpenses', 'operatingCosts'))
        THEN amount ELSE -amount END)::text AS amount
      FROM classified WHERE key IS NOT NULL GROUP BY key ORDER BY key`);
  }

  async propertyNights(propertyId: string, fromOn: string, toOn: string) {
    const [result] = await this.nights(fromOn, toOn, propertyId);
    return result;
  }

  portfolioNights(fromOn: string, toOn: string, scope?: { propertyId: string | null; ownerId?: string; bookingSource?: string }) {
    return this.nights(fromOn, toOn, scope?.propertyId ?? undefined, scope);
  }

  async commandFinance(input: { currency: string; startsAt: Date; endsAt: Date }) {
    const [postings, accounts, payable] = await Promise.all([
      this.companyPostings(input),
      new CompanyLedgerRepository(this.tx, this.organizationId).totals(input),
      new OwnerStatementRepository(this.tx, this.organizationId).portfolioPayable(input.currency, input.endsAt)
    ]);
    return { postings, accounts, payable };
  }

  companyPostings(input: { currency: string; startsAt: Date; endsAt: Date }) {
    return this.tx.$queryRaw<CompanyPostingTotal[]>(Prisma.sql`
      WITH classified AS (
        SELECT CASE
          WHEN a.account_type = 'ALVILLAS_OWN' AND a.code = 'ALVILLAS_COMMISSION_REVENUE' THEN 'commission'
          WHEN a.account_type = 'ALVILLAS_OWN' AND a.code = 'ALVILLAS_SERVICE_REVENUE' THEN 'companyServiceRevenue'
          WHEN a.account_type = 'ALVILLAS_OWN' AND a.code = 'ALVILLAS_EXPENSE' THEN 'operatingCosts'
          WHEN a.account_type = 'ASSET_LOCATION' AND a.normal_side = 'DEBIT' AND a.code ~ '^BANK($|_)' THEN 'bankBalance'
          WHEN a.account_type = 'ASSET_LOCATION' AND a.normal_side = 'DEBIT' AND a.code ~ '^CASH($|_)'
            AND a.code !~ '^CASH_CUSTODY($|[_:])' THEN 'cashBalance'
        END AS key, property.id AS property_id, p.amount, p.side, t.occurred_at
        FROM posting p
        JOIN financial_transaction t ON t.organization_id = p.organization_id AND t.id = p.transaction_id
        JOIN ledger_account a ON a.organization_id = p.organization_id AND a.id = p.ledger_account_id
        LEFT JOIN property ON property.organization_id = p.organization_id AND property.id::text = p.dimensions->>'property_id'
        WHERE p.organization_id = ${this.organizationId}::uuid AND p.currency = ${input.currency}
          AND t.sealed AND t.occurred_at < ${input.endsAt}
          AND (a.account_type = 'ASSET_LOCATION' OR t.occurred_at >= ${input.startsAt})
      )
      SELECT key, CASE WHEN key IN ('cashBalance','bankBalance') THEN NULL ELSE property_id END AS "propertyId",
        sum(CASE WHEN (side = 'DEBIT') = (key IN ('operatingCosts','bankBalance','cashBalance')) THEN amount ELSE -amount END)::text AS amount
      FROM classified WHERE key IS NOT NULL GROUP BY key, "propertyId" ORDER BY key, "propertyId"`);
  }

  teamPerformance(input: { currency: string; timezone: string; fromOn: string; toOn: string; startsAt: Date; endsAt: Date }) {
    return this.tx.$queryRaw<TeamPerformanceSource[]>(Prisma.sql`
      WITH workload AS (
        SELECT assigned_to_person_id AS person_id, count(*) AS assigned,
          count(*) FILTER (WHERE state IN ('PLANNED','ASSIGNED','IN_PROGRESS','BLOCKED')) AS open
        FROM operation_task
        WHERE organization_id = ${this.organizationId}::uuid AND archived_at IS NULL
          AND state NOT IN ('CANCELLED','SKIPPED') AND assigned_to_person_id IS NOT NULL
          AND due_date BETWEEN ${input.fromOn}::date AND ${input.toOn}::date
        GROUP BY assigned_to_person_id
      ), completions AS (
        SELECT task.completed_by_person_id AS person_id, count(*) AS completed,
          count(*) FILTER (WHERE (task.completed_at AT TIME ZONE property.timezone)::date <= task.due_date) AS on_time
        FROM operation_task task JOIN property ON property.organization_id=task.organization_id AND property.id=task.property_id
        WHERE task.organization_id = ${this.organizationId}::uuid AND task.completed_by_person_id IS NOT NULL AND task.state = 'COMPLETED'
          AND task.completed_at >= ${input.startsAt} AND task.completed_at < ${input.endsAt}
        GROUP BY task.completed_by_person_id
      ), compensation AS (
        SELECT c.person_id, sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END) AS recognized
        FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
        JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
        JOIN employee_compensation_claim c ON c.organization_id=p.organization_id AND c.id::text=p.dimensions->>'employee_compensation_claim_id'
          AND c.person_id::text=p.dimensions->>'employee_person_id'
        WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency}
          AND a.code='EMPLOYEE_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND p.bucket='EMPLOYEE_COMPENSATION'
          AND t.sealed AND t.occurred_at>=${input.startsAt} AND t.occurred_at<${input.endsAt}
        GROUP BY c.person_id
      ), wallet AS (
        SELECT w.person_id, sum(p.amount) FILTER (WHERE p.side='DEBIT') AS debit,
          sum(p.amount) FILTER (WHERE p.side='CREDIT') AS credit
        FROM team_wallet w JOIN posting p ON p.organization_id=w.organization_id AND p.ledger_account_id=w.ledger_account_id
        JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
        WHERE w.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency}
          AND t.sealed AND t.occurred_at>=${input.startsAt} AND t.occurred_at<${input.endsAt}
        GROUP BY w.person_id
      ), involved AS (
        SELECT person_id FROM workload UNION SELECT person_id FROM completions
        UNION SELECT person_id FROM compensation UNION SELECT person_id FROM wallet
      )
      SELECT p.id, p.display_name AS name, coalesce(w.assigned,0)::text AS assigned, coalesce(w.open,0)::text AS open,
        coalesce(j.completed,0)::text AS completed, coalesce(j.on_time,0)::text AS "onTime",
        coalesce(c.recognized,0)::text AS recognized, coalesce(wallet.debit,0)::text AS "walletDebits",
        coalesce(wallet.credit,0)::text AS "walletCredits"
      FROM involved staff JOIN person p ON p.organization_id=${this.organizationId}::uuid AND p.id=staff.person_id
      LEFT JOIN workload w ON w.person_id=p.id LEFT JOIN completions j ON j.person_id=p.id
      LEFT JOIN compensation c ON c.person_id=p.id LEFT JOIN wallet ON wallet.person_id=p.id
      ORDER BY p.display_name,p.id`);
  }

  protected nights(fromOn: string, toOn: string, propertyId?: string, scope?: { ownerId?: string; bookingSource?: string }) {
    return this.tx.$queryRaw<PortfolioNights[]>(Prisma.sql`
      WITH properties AS (
        SELECT id, name, daterange(${fromOn}::date, ${toOn}::date + 1, '[)') AS period
        FROM property WHERE organization_id = ${this.organizationId}::uuid
        ${propertyId ? Prisma.sql`AND id = ${propertyId}::uuid` : Prisma.sql`AND archived_at IS NULL AND status = 'ACTIVE'`}
        ${scope?.ownerId ? Prisma.sql`AND EXISTS (SELECT 1 FROM property_owner owner
          WHERE owner.organization_id=property.organization_id AND owner.property_id=property.id
            AND owner.owner_id=${scope.ownerId}::uuid AND owner.archived_at IS NULL)` : Prisma.empty}
      ), reservation_nights AS (
        SELECT r.property_id, range_agg(daterange(r.check_in, r.check_out, '[)') * p.period) AS nights,
          sum(upper(daterange(r.check_in, r.check_out, '[)') * p.period)
            - lower(daterange(r.check_in, r.check_out, '[)') * p.period)) AS original_nights
        FROM reservation r JOIN properties p ON p.id = r.property_id
        WHERE r.organization_id = ${this.organizationId}::uuid AND r.archived_at IS NULL
          AND r.status IN ('CHECKED_IN','STAYING','CHECKED_OUT','FINANCIAL_RECONCILIATION','CLOSED')
          ${scope?.bookingSource ? Prisma.sql`AND r.source=${scope.bookingSource}` : Prisma.empty}
          AND r.check_in < upper(p.period) AND r.check_out > lower(p.period)
        GROUP BY r.property_id
      ), blocked_nights AS (
        SELECT b.property_id, range_agg(daterange(b.check_in, b.check_out, '[)') * p.period) AS nights
        FROM calendar_block b JOIN properties p ON p.id = b.property_id
        WHERE b.organization_id = ${this.organizationId}::uuid AND b.status = 'ACTIVE' AND b.archived_at IS NULL
          AND b.check_in < upper(p.period) AND b.check_out > lower(p.period)
        GROUP BY b.property_id
      )
      SELECT p.id AS "propertyId", p.name AS "propertyName",
        ((upper(p.period) - lower(p.period)) - blocked.total)::text AS available,
        occupied.total::text AS occupied, blocked.total::text AS blocked,
        (coalesce(r.original_nights,0) - occupied.total + overlap.total)::text AS conflicts
      FROM properties p
      LEFT JOIN reservation_nights r ON r.property_id = p.id
      LEFT JOIN blocked_nights b ON b.property_id = p.id
      CROSS JOIN LATERAL (SELECT coalesce(sum(upper(night) - lower(night)),0) AS total FROM unnest(b.nights) AS night) blocked
      CROSS JOIN LATERAL (SELECT coalesce(sum(upper(night) - lower(night)),0) AS total FROM unnest(r.nights) AS night) occupied
      CROSS JOIN LATERAL (SELECT coalesce(sum(upper(night) - lower(night)),0) AS total FROM unnest(r.nights * b.nights) AS night) overlap
      ORDER BY p.name,p.id`);
  }
}
