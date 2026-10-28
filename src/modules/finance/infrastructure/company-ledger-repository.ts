import { Prisma } from "@prisma/client";
import { LedgerCalendarRepository } from "./ledger-calendar-repository";
import type { CompanyLedgerAccountTotals } from "../domain/company-ledger";

type Range = { startsAt: Date; endsAt: Date; currency: string };
export type CompanyLedgerLine = { id: string; transactionId: string; reference: string; occurredAt: string;
  accountId: string; accountCode: string; accountName: string; side: "DEBIT" | "CREDIT"; amount: string; runningBalance: string };

export class CompanyLedgerRepository extends LedgerCalendarRepository {
  private scope(input: Range) {
    return Prisma.sql`p.organization_id=${this.organizationId}::uuid AND a.account_type='ALVILLAS_OWN'
      AND p.currency=${input.currency} AND ft.occurred_at < ${input.endsAt}`;
  }

  async totals(input: Range) {
    return this.tx.$queryRaw<CompanyLedgerAccountTotals[]>(Prisma.sql`
      SELECT a.id, a.code, a.name,
        COALESCE(SUM(CASE WHEN ft.occurred_at < ${input.startsAt} THEN CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS opening,
        COALESCE(SUM(p.amount) FILTER (WHERE ft.occurred_at >= ${input.startsAt} AND p.side='CREDIT'),0)::text AS credits,
        COALESCE(SUM(p.amount) FILTER (WHERE ft.occurred_at >= ${input.startsAt} AND p.side='DEBIT'),0)::text AS debits,
        COUNT(*) FILTER (WHERE ft.occurred_at >= ${input.startsAt})::text AS count
      FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      JOIN financial_transaction ft ON ft.organization_id=p.organization_id AND ft.id=p.transaction_id
      WHERE ${this.scope(input)} GROUP BY a.id,a.code,a.name ORDER BY a.code,a.id`);
  }

  async page(input: Range & { openingBalance: string; after?: string }) {
    const [result] = await this.tx.$queryRaw<Array<{ cursorFound: boolean; lines: CompanyLedgerLine[] }>>(Prisma.sql`
      WITH ordered AS MATERIALIZED (
        SELECT p.id, ft.id AS "transactionId", ft.reference, ft.occurred_at AS "occurredAt",
          a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", p.side, p.amount::text AS amount,
          (${input.openingBalance}::numeric + SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END)
            OVER (ORDER BY ft.occurred_at,ft.reference,p.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS "runningBalance",
          ROW_NUMBER() OVER (ORDER BY ft.occurred_at,ft.reference,p.id) AS ordinal
        FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
        JOIN financial_transaction ft ON ft.organization_id=p.organization_id AND ft.id=p.transaction_id
        WHERE ${this.scope(input)} AND ft.occurred_at >= ${input.startsAt}
      ), page AS (
        SELECT * FROM ordered WHERE ordinal > ${input.after ? Prisma.sql`(SELECT ordinal FROM ordered WHERE id=${input.after}::uuid)` : Prisma.sql`0`}
        ORDER BY ordinal LIMIT 51
      ) SELECT ${input.after ? Prisma.sql`EXISTS(SELECT 1 FROM ordered WHERE id=${input.after}::uuid)` : Prisma.sql`true`} AS "cursorFound",
        COALESCE((SELECT jsonb_agg(to_jsonb(page)-'ordinal' ORDER BY ordinal) FROM page),'[]'::jsonb) AS lines`);
    return result;
  }
}
