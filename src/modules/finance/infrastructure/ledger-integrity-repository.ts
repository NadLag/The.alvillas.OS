import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { IntegrityAccount, IntegrityMovement, IntegrityTransaction } from "../domain/ledger-integrity";

// Technical foreign-key identities, including retained historical source rows.
// Labels, references, categories and configuration values are not dimensions.
const dimensionSources = [
  { keys: ["property_id", "propertyId"], table: "property" },
  { keys: ["owner_id", "ownerId"], table: "owner" },
  { keys: ["reservation_id", "reservationId"], table: "reservation" },
  { keys: ["guest_id", "guestId"], table: "guest" },
  { keys: ["supplier_id", "supplierId"], table: "supplier" },
  { keys: ["supplier_invoice_id", "supplierInvoiceId"], table: "supplier_invoice" },
  { keys: ["person_id", "personId"], table: "person" },
  { keys: ["employee_compensation_claim_id"], table: "employee_compensation_claim" },
  { keys: ["cash_collection_id", "cashCollectionId"], table: "cash_collection" },
  { keys: ["original_transaction_id", "source_transaction_id"], table: "financial_transaction" }
] as const;
const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export class LedgerIntegrityRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async lock() {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":ledger-integrity"},0))::text`);
  }
  async movements(after: string | undefined, limit: number) {
    const dimensions = dimensionSources.flatMap(source => source.keys.map(name => Prisma.sql`
      (p.dimensions IS NULL OR NOT (p.dimensions ? ${name}) OR p.dimensions->${name}='null'::jsonb OR
        (jsonb_typeof(p.dimensions->${name})='string' AND EXISTS (SELECT 1 FROM ${Prisma.raw(source.table)} dimension
          WHERE dimension.organization_id=p.organization_id AND dimension.id=CASE WHEN p.dimensions->>${name} ~ ${uuidPattern} THEN (p.dimensions->>${name})::uuid ELSE NULL END)))`));
    return this.tx.$queryRaw<IntegrityMovement[]>(Prisma.sql`SELECT p.id::text,p.transaction_id::text AS "transactionId",p.ledger_account_id::text AS "accountId",
      p.currency::text AS currency,p.amount::text AS amount,p.side,coalesce(a.account_type,'') AS "accountType",
      (t.id IS NOT NULL AND a.id IS NOT NULL AND (p.dimensions IS NULL OR jsonb_typeof(p.dimensions)='object') AND ${Prisma.join(dimensions," AND ")}) AS "validScope"
      FROM posting p LEFT JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      LEFT JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE p.organization_id=${this.organizationId}::uuid ${after ? Prisma.sql`AND p.id>${after}::uuid` : Prisma.empty} ORDER BY p.id LIMIT ${limit}`);
  }
  async accounts(): Promise<IntegrityAccount[]> {
    return this.tx.$queryRaw<IntegrityAccount[]>(Prisma.sql`SELECT ledger_account_id::text AS id,currency::text,
      coalesce(sum(amount) FILTER(WHERE side='DEBIT'),0)::text AS debits,coalesce(sum(amount) FILTER(WHERE side='CREDIT'),0)::text AS credits
      FROM posting WHERE organization_id=${this.organizationId}::uuid GROUP BY ledger_account_id,currency ORDER BY ledger_account_id,currency`);
  }
  transactions() {
    return this.tx.$queryRaw<IntegrityTransaction[]>(Prisma.sql`SELECT t.id::text,p.currency::text,t.sealed,
      count(p.id)::text AS "postingCount",coalesce(sum(p.amount) FILTER(WHERE p.side='DEBIT'),0)::text AS debits,
      coalesce(sum(p.amount) FILTER(WHERE p.side='CREDIT'),0)::text AS credits FROM financial_transaction t
      LEFT JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
      WHERE t.organization_id=${this.organizationId}::uuid GROUP BY t.id,t.sealed,p.currency ORDER BY t.id,p.currency`);
  }
  fingerprints(after: string | undefined, limit: number) {
    return this.tx.$queryRaw<Array<{ id: string; fingerprint: string }>>(Prisma.sql`SELECT id::text,
      app_ledger_integrity_journal_hash(organization_id,id) AS fingerprint FROM financial_transaction
      WHERE organization_id=${this.organizationId}::uuid ${after ? Prisma.sql`AND id>${after}::uuid` : Prisma.empty} ORDER BY id LIMIT ${limit}`);
  }
  retainedDifferences() {
    return this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT transaction_id::text AS id FROM ledger_integrity_source
      WHERE organization_id=${this.organizationId}::uuid AND fingerprint IS DISTINCT FROM app_ledger_integrity_journal_hash(organization_id,transaction_id)
      ORDER BY transaction_id`);
  }
  closedPeriodDifferences() {
    // A later CLOSE seals its exact snapshot. A REOPEN can legitimately add
    // movements before its configured deadline, including after earlier closes.
    return this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT p.id::text FROM accounting_period p
      JOIN LATERAL(SELECT kind,snapshot FROM accounting_period_event e WHERE e.organization_id=p.organization_id AND e.period_id=p.id ORDER BY version DESC LIMIT 1) e ON true
      WHERE p.organization_id=${this.organizationId}::uuid AND e.kind='CLOSE'
      AND e.snapshot IS DISTINCT FROM app_accounting_period_snapshot(p.organization_id,p.starts_at,p.ends_at) ORDER BY p.id`);
  }
  async snapshotMatches(rows: readonly { id: string; fingerprint: string }[]) {
    if (!rows.length) return true;
    const [result] = await this.tx.$queryRaw<Array<{ matches: boolean }>>(Prisma.sql`WITH expected(id,fingerprint) AS(VALUES ${Prisma.join(rows.map(row => Prisma.sql`(${row.id}::uuid,${row.fingerprint}::text)`))})
      SELECT NOT EXISTS(SELECT 1 FROM expected WHERE fingerprint IS DISTINCT FROM app_ledger_integrity_journal_hash(${this.organizationId}::uuid,id)) AS matches`);
    return result.matches;
  }
  async preserveSources(rows: readonly { id: string; fingerprint: string }[]) {
    if (!rows.length) return 0;
    return this.tx.$executeRaw(Prisma.sql`INSERT INTO ledger_integrity_source(organization_id,transaction_id,fingerprint)
      VALUES ${Prisma.join(rows.map(row => Prisma.sql`(${this.organizationId}::uuid,${row.id}::uuid,${row.fingerprint})`))}
      ON CONFLICT(organization_id,transaction_id) DO NOTHING`);
  }
  async completed(policyRuleId: string, on: string) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string; passed: boolean }>>(Prisma.sql`SELECT id::text,passed FROM ledger_integrity_run
      WHERE organization_id=${this.organizationId}::uuid AND policy_rule_id=${policyRuleId}::uuid AND "on"=${on}::date`);
    return row ?? null;
  }
  async record(input: { on: string; policyRuleId: string; createdBy: string; checkedAt: Date; passed: boolean; report: Prisma.InputJsonObject }) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string; passed: boolean }>>(Prisma.sql`INSERT INTO ledger_integrity_run(organization_id,"on",policy_rule_id,created_by,checked_at,passed,report)
      VALUES(${this.organizationId}::uuid,${input.on}::date,${input.policyRuleId}::uuid,${input.createdBy}::uuid,${input.checkedAt},${input.passed},${JSON.stringify(input.report)}::jsonb)
      RETURNING id::text,passed`);
    return row;
  }
  async guardState() {
    const [row] = await this.tx.$queryRaw<Array<{ protected: boolean }>>(Prisma.sql`SELECT
      (SELECT count(*)=9 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN('O','A') AND
        ((tgrelid='financial_transaction'::regclass AND tgname IN('financial_transaction_no_update','financial_transaction_no_delete','financial_transaction_balanced_on_header','financial_transaction_begin_write','financial_transaction_finish_write')) OR
         (tgrelid='posting'::regclass AND tgname IN('posting_no_update','posting_no_delete','financial_transaction_balanced_on_posting','posting_header_unsealed')))) AS protected`);
    return row.protected;
  }
}
