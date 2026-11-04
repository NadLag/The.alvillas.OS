import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export type AccountantBankAccount = { id: string; code: string; name: string; accountType: string; normalSide: string; archivedAt: Date | null };
export type AccountantBankExpected = { id: string; transactionId: string; accountId: string; reference: string; description: string | null;
  occurredAt: string; side: "DEBIT" | "CREDIT"; amount: string; currency: string; reversesTransactionId: string | null; reversalIds: string[] };
export type AccountantBankLine = { id: string; ledgerAccountId: string; bankIdentityHash: string; currency: string; externalId: string | null;
  correctsExternalId: string | null; correctionAction: string | null; postedOn: string | null; amount: string | null; source: unknown; createdAt: string };
export type AccountantBankHistory = { kind: "MATCH" | "ALLOCATION" | "EVIDENCE"; identity: string; data: unknown };

/** Only original account bindings, provider facts, sealed journals and retained reconciliation events are projected. */
export class AccountantBankExportRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  accounts(currency: string, configuredCodes: readonly string[]): Promise<AccountantBankAccount[]> {
    return this.tx.$queryRaw<AccountantBankAccount[]>(Prisma.sql`SELECT a.id,a.code,a.name,a.account_type AS "accountType",a.normal_side AS "normalSide",a.archived_at AS "archivedAt"
      FROM ledger_account a WHERE a.organization_id=${this.organizationId}::uuid AND a.account_type='ASSET_LOCATION' AND a.normal_side='DEBIT'
      AND (a.code=ANY(${[...configuredCodes]}::text[]) OR EXISTS(SELECT 1 FROM bank_statement_line l WHERE l.organization_id=a.organization_id AND l.ledger_account_id=a.id AND l.currency=${currency})
        OR EXISTS(SELECT 1 FROM config_rule c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.value->'accounts')='array' THEN c.value->'accounts' ELSE '[]'::jsonb END) binding
          WHERE c.organization_id=a.organization_id AND c.key='finance.bank_statements' AND c.scope_type='organization' AND c.scope_id IS NULL
            AND c.lifecycle IN ('ACTIVE','RETIRED') AND c.effective_from<=clock_timestamp()
            AND binding->>'account_code'=a.code AND binding->>'currency'=${currency})) ORDER BY a.id`);
  }
  expected(input: { accountIds: string[]; currency: string; startsAt: Date; endsAt: Date; maxRows: number }): Promise<AccountantBankExpected[]> {
    return this.tx.$queryRaw<AccountantBankExpected[]>(Prisma.sql`SELECT p.id,p.transaction_id AS "transactionId",p.ledger_account_id AS "accountId",t.reference,t.description,
      to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",p.side,p.amount::text,p.currency,t.reverses_transaction_id AS "reversesTransactionId",
      ARRAY(SELECT r.id::text FROM financial_transaction r WHERE r.organization_id=t.organization_id AND r.reverses_transaction_id=t.id ORDER BY r.id) AS "reversalIds"
      FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      WHERE p.organization_id=${this.organizationId}::uuid AND p.ledger_account_id=ANY(${input.accountIds}::uuid[]) AND p.currency=${input.currency} AND t.sealed
      AND t.occurred_at>=${input.startsAt} AND t.occurred_at<${input.endsAt} ORDER BY t.occurred_at,t.id,p.id LIMIT ${input.maxRows + 1}`);
  }
  lineIds(input: { accountIds: string[]; currency: string; fromOn: string; toOn: string; startsAt: Date; endsAt: Date; maxRows: number }) {
    return this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM bank_statement_line WHERE organization_id=${this.organizationId}::uuid
      AND ledger_account_id=ANY(${input.accountIds}::uuid[]) AND currency=${input.currency}
      AND (posted_on BETWEEN ${input.fromOn}::date AND ${input.toOn}::date OR posted_on IS NULL AND created_at>=${input.startsAt} AND created_at<${input.endsAt})
      ORDER BY id LIMIT ${input.maxRows + 1}`);
  }
  lines(ids: string[]): Promise<AccountantBankLine[]> {
    return this.tx.$queryRaw<AccountantBankLine[]>(Prisma.sql`SELECT id,ledger_account_id AS "ledgerAccountId",bank_identity_hash AS "bankIdentityHash",currency,external_id AS "externalId",
      corrects_external_id AS "correctsExternalId",correction_action AS "correctionAction",to_char(posted_on,'YYYY-MM-DD') AS "postedOn",amount::text,source,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM bank_statement_line
      WHERE organization_id=${this.organizationId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id`);
  }
  history(input: { accountIds: string[]; currency: string; postingIds: string[]; lineIds: string[]; maxRows: number }): Promise<AccountantBankHistory[]> {
    return this.tx.$queryRaw<AccountantBankHistory[]>(Prisma.sql`WITH selected AS MATERIALIZED (
      SELECT e.*,released.id AS release_id FROM bank_reconciliation_entry e LEFT JOIN bank_reconciliation_entry released ON released.organization_id=e.organization_id AND released.previous_entry_id=e.id
      WHERE e.organization_id=${this.organizationId}::uuid AND e.ledger_account_id=ANY(${input.accountIds}::uuid[]) AND e.currency=${input.currency} AND e.action='MATCH'
      AND (EXISTS(SELECT 1 FROM bank_reconciliation_allocation a WHERE a.organization_id=e.organization_id AND a.entry_id=e.id
        AND (a.posting_id=ANY(${input.postingIds}::uuid[]) OR a.line_id=ANY(${input.lineIds}::uuid[])))
        OR EXISTS(SELECT 1 FROM bank_reconciliation_evidence v WHERE v.organization_id=e.organization_id AND v.entry_id=e.id AND v.line_id=ANY(${input.lineIds}::uuid[])))
      ORDER BY e.created_at,e.id LIMIT ${input.maxRows + 1}
    ), records AS (
      SELECT 'MATCH' AS kind,e.id::text AS identity,jsonb_build_object('id',e.id,'entryId',e.id,'accountId',e.ledger_account_id,'currency',e.currency,'snapshot',e.snapshot,
        'policySnapshot',e.policy_snapshot,'reason',e.reason,'releaseId',e.release_id,'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS data
      FROM selected e
      UNION ALL SELECT 'ALLOCATION',a.id::text,jsonb_build_object('id',a.id,'entryId',a.entry_id,'accountId',e.ledger_account_id,'currency',e.currency,'postingId',a.posting_id,'lineId',a.line_id,
        'amount',a.amount::text,'original',a.original_amount::text,'allocatedBefore',a.allocated_before::text,'sourceSnapshot',a.source_snapshot)
      FROM selected e JOIN bank_reconciliation_allocation a ON a.organization_id=e.organization_id AND a.entry_id=e.id
      UNION ALL SELECT 'EVIDENCE',v.entry_id::text||':'||v.line_id::text,jsonb_build_object('id',v.line_id,'entryId',v.entry_id,'accountId',e.ledger_account_id,'currency',e.currency,'lineId',v.line_id,'sourceSnapshot',v.source_snapshot)
      FROM selected e JOIN bank_reconciliation_evidence v ON v.organization_id=e.organization_id AND v.entry_id=e.id
    ) SELECT kind,identity,data FROM records ORDER BY kind,identity LIMIT ${input.maxRows + 1}`);
  }
}
