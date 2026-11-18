import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export type OwnerMoneyRail = "BOOKING_RECEIPT" | "APPLIED_GUEST_PAYMENT" | "SERVICE_CASH" | "ALVILLAS_PAYOUT";
type Row = { id: string; reference: string; occurredAt: Date; side: "DEBIT" | "CREDIT"; amount: string; rail: OwnerMoneyRail; reversal: boolean };

export class OwnerMoneyMovementRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  movements(input: { ownerId: string; propertyId: string; currency: string; periodStart: Date; periodEnd: Date }) {
    return this.tx.$queryRaw<Row[]>(Prisma.sql`
      WITH owner_posting AS (
        SELECT p.id, p.side, p.amount, p.bucket, p.dimensions, journal.reference,
          journal.occurred_at, journal.reverses_transaction_id IS NOT NULL AS reversal,
          coalesce(journal.reverses_transaction_id, journal.id) AS original_id
        FROM posting p
        JOIN ledger_account account ON account.organization_id=p.organization_id AND account.id=p.ledger_account_id
        JOIN financial_transaction journal ON journal.organization_id=p.organization_id AND journal.id=p.transaction_id AND journal.sealed
        WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency}
          AND account.code='OWNER_PAYABLE' AND account.account_type='CLAIM_OWNERSHIP' AND account.normal_side='CREDIT'
          AND p.dimensions @> jsonb_build_object('owner_id', ${input.ownerId}::text, 'property_id', ${input.propertyId}::text)
          AND journal.occurred_at>=${input.periodStart} AND journal.occurred_at<${input.periodEnd}
          AND p.bucket IN ('OWNER_REVENUE','OWNER_SERVICES','PAYOUT')
      ), classified AS (
        SELECT p.*, CASE
          WHEN p.bucket='PAYOUT' AND p.dimensions->>'source'='OWNER_PAYOUT' AND EXISTS (
            SELECT 1 FROM posting peer JOIN ledger_account account ON account.organization_id=peer.organization_id AND account.id=peer.ledger_account_id
            WHERE peer.organization_id=${this.organizationId}::uuid AND peer.transaction_id=p.original_id
              AND peer.bucket='PAYOUT_PAYMENT' AND peer.side='CREDIT' AND account.account_type='ASSET_LOCATION'
              AND peer.currency=${input.currency} AND peer.amount=p.amount
              AND peer.dimensions->>'payout_id'=p.dimensions->>'payout_id'
              AND peer.dimensions->>'owner_id'=p.dimensions->>'owner_id'
              AND peer.dimensions->>'property_id'=p.dimensions->>'property_id'
          ) THEN 'ALVILLAS_PAYOUT'
          WHEN p.bucket='OWNER_REVENUE' AND p.dimensions->>'posting_kind'='owner_accommodation_revenue' AND EXISTS (
            SELECT 1 FROM posting peer JOIN ledger_account account ON account.organization_id=peer.organization_id AND account.id=peer.ledger_account_id
            WHERE peer.organization_id=${this.organizationId}::uuid AND peer.transaction_id=p.original_id
              AND peer.dimensions->>'posting_kind'='accommodation_revenue_received' AND peer.side='DEBIT'
              AND peer.currency=${input.currency} AND account.account_type='ASSET_LOCATION'
          ) THEN 'BOOKING_RECEIPT'
          WHEN p.bucket='OWNER_REVENUE' AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT' AND EXISTS (
            SELECT 1 FROM guest_payment_receipt receipt
            JOIN guest_payment_receipt_owner attributed ON attributed.organization_id=receipt.organization_id AND attributed.receipt_id=receipt.id
            JOIN financial_transaction receipt_journal ON receipt_journal.organization_id=receipt.organization_id
              AND receipt_journal.id=receipt.transaction_id AND receipt_journal.sealed
            WHERE receipt.organization_id=${this.organizationId}::uuid AND receipt.transaction_id::text=p.dimensions->>'original_transaction_id'
              AND receipt.property_id=${input.propertyId}::uuid AND receipt.currency=${input.currency}
              AND attributed.owner_id=${input.ownerId}::uuid
          ) THEN 'APPLIED_GUEST_PAYMENT'
          WHEN p.bucket='OWNER_SERVICES' AND p.dimensions->>'source'='SERVICE_ALLOCATION' AND EXISTS (
            SELECT 1 FROM service_allocation_posting allocation
            JOIN service_financial_source source ON source.organization_id=allocation.organization_id AND source.id=allocation.source_id
            JOIN cash_collection receipt ON receipt.organization_id=source.organization_id AND receipt.id=source.cash_collection_id
            JOIN financial_transaction receipt_journal ON receipt_journal.organization_id=receipt.organization_id
              AND receipt_journal.id=receipt.transaction_id AND receipt_journal.sealed
            WHERE allocation.organization_id=${this.organizationId}::uuid AND allocation.transaction_id=p.original_id
              AND receipt.property_id=${input.propertyId}::uuid AND receipt.currency=${input.currency}
          ) THEN 'SERVICE_CASH'
        END AS rail FROM owner_posting p
      )
      SELECT id,reference,occurred_at AS "occurredAt",side,amount::text,rail,reversal FROM classified WHERE rail IS NOT NULL
      ORDER BY occurred_at DESC,id DESC`);
  }
}
