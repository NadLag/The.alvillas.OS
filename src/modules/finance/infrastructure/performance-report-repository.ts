import { Prisma } from "@prisma/client";
import { PropertyFinanceRepository } from "./property-finance-repository";
import type { CompanyPostingTotal, PortfolioNights, PropertyPostingTotal } from "../domain/performance-report";

export class PerformanceReportRepository extends PropertyFinanceRepository {
  propertyPostings(input: { propertyId: string; currency: string; startsAt: Date; endsAt: Date }) {
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
          AND coalesce(cash.property_id::text,p.dimensions->>'property_id') = ${input.propertyId}
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

  portfolioNights(fromOn: string, toOn: string) {
    return this.nights(fromOn, toOn);
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

  protected nights(fromOn: string, toOn: string, propertyId?: string) {
    return this.tx.$queryRaw<PortfolioNights[]>(Prisma.sql`
      WITH properties AS (
        SELECT id, name, daterange(${fromOn}::date, ${toOn}::date + 1, '[)') AS period
        FROM property WHERE organization_id = ${this.organizationId}::uuid
        ${propertyId ? Prisma.sql`AND id = ${propertyId}::uuid` : Prisma.sql`AND archived_at IS NULL AND status = 'ACTIVE'`}
      ), reservation_nights AS (
        SELECT r.property_id, range_agg(daterange(r.check_in, r.check_out, '[)') * p.period) AS nights,
          sum(upper(daterange(r.check_in, r.check_out, '[)') * p.period)
            - lower(daterange(r.check_in, r.check_out, '[)') * p.period)) AS original_nights
        FROM reservation r JOIN properties p ON p.id = r.property_id
        WHERE r.organization_id = ${this.organizationId}::uuid AND r.archived_at IS NULL
          AND r.status IN ('CHECKED_IN','STAYING','CHECKED_OUT','FINANCIAL_RECONCILIATION','CLOSED')
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
