import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

type Row = {
  id: string; state: string; amount: string; method: string; cadence: string | null; futureAmount: string | null; futureCurrency: string | null;
  eligibleAt: Date | null; scheduledFor: Date | null; expectedAt: Date | null; confirmedAt: Date | null;
  approvalSteps: number; referenceSuffix: string | null;
};

export class OwnerPayoutReadRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async rows(input: { propertyId: string; ownerId: string; currency: string; from: Date; to: Date }) {
    // PR #130 owns the payout state and schema. This projection is available only after its native schema is deployed.
    const [schema] = await this.tx.$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.owner_payout')
          AND attname='expected_settlement_at' AND NOT attisdropped
      ) AS available`;
    if (!schema.available) return null;

    return this.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id,p.state,p.amount::text,method.method_type AS method,p.policy_snapshot#>>'{payout,cadence}' AS cadence,
        p.policy_snapshot#>>'{amount,amount}' AS "futureAmount",p.policy_snapshot#>>'{amount,currency}' AS "futureCurrency",
        p.eligible_at AS "eligibleAt",p.scheduled_for AS "scheduledFor",p.expected_settlement_at AS "expectedAt",
        actual.at AS "confirmedAt",
        CASE WHEN jsonb_typeof(p.policy_snapshot->'stages')='array' THEN jsonb_array_length(p.policy_snapshot->'stages') ELSE 0 END AS "approvalSteps",
        CASE WHEN actual.at IS NOT NULL AND p.payment_reference ~ '^[A-Za-z0-9._/-]{8,160}$'
          THEN right(p.payment_reference,4) ELSE NULL END AS "referenceSuffix"
      FROM owner_payout p
      JOIN owner_payout_method method ON method.organization_id=p.organization_id AND method.id=p.payout_method_id
        AND method.owner_id=p.owner_id AND method.currency=p.currency
      LEFT JOIN LATERAL (
        SELECT p.paid_at AS at FROM financial_transaction journal
        JOIN posting claim ON claim.organization_id=journal.organization_id AND claim.transaction_id=journal.id
        JOIN ledger_account account ON account.organization_id=claim.organization_id AND account.id=claim.ledger_account_id
        WHERE journal.organization_id=p.organization_id AND journal.id=p.transaction_id AND journal.sealed
          AND p.state IN ('PAID','RECONCILED') AND p.reversal_transaction_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=journal.organization_id
              AND reversal.reverses_transaction_id=journal.id AND reversal.sealed)
          AND account.code='OWNER_PAYABLE' AND account.account_type='CLAIM_OWNERSHIP'
          AND claim.bucket='PAYOUT' AND claim.side='DEBIT' AND claim.currency=p.currency AND claim.amount=p.amount
          AND claim.dimensions @> jsonb_build_object('payout_id',p.id::text,'owner_id',p.owner_id::text,'property_id',p.property_id::text)
          AND EXISTS (
            SELECT 1 FROM posting funding JOIN ledger_account location ON location.organization_id=funding.organization_id AND location.id=funding.ledger_account_id
            WHERE funding.organization_id=journal.organization_id AND funding.transaction_id=journal.id AND funding.ledger_account_id=p.funding_account_id
              AND funding.side='CREDIT' AND funding.bucket='PAYOUT_PAYMENT' AND funding.currency=p.currency AND funding.amount=p.amount
              AND funding.dimensions=claim.dimensions AND location.account_type='ASSET_LOCATION'
          )
        LIMIT 1
      ) actual ON TRUE
      WHERE p.organization_id=${this.organizationId}::uuid AND p.owner_id=${input.ownerId}::uuid AND p.property_id=${input.propertyId}::uuid
        AND p.currency=${input.currency} AND p.state<>'DRAFT'
        AND coalesce(p.paid_at,p.scheduled_for,p.eligible_at,p.created_at)>=${input.from}
        AND coalesce(p.paid_at,p.scheduled_for,p.eligible_at,p.created_at)<${input.to}
      ORDER BY coalesce(p.paid_at,p.scheduled_for,p.eligible_at,p.created_at) DESC,p.id DESC`);
  }
}
