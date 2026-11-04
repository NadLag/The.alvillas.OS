import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { VarianceCenterProvider } from "../domain/variance-center";

export type VarianceCenterCandidate = { id: string; at: string; reference: string };

/** A fixed native page, ordered by original source time with full PostgreSQL microseconds. */
export class VarianceCenterRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  candidates(provider: VarianceCenterProvider, after?: { id: string; at: string }) {
    const org = this.organizationId;
    const roots = provider === "OTA" ? Prisma.sql`
      SELECT v.id,v.created_at AS source_time,s.source_transaction_id AS reference
      FROM variance v JOIN airbnb_settlement s ON s.organization_id=v.organization_id AND s.id=v.source_id
      WHERE v.organization_id=${org}::uuid AND v.source_type='AIRBNB_SETTLEMENT'` : provider === "BANK" ? Prisma.sql`
      SELECT b.id,b.created_at AS source_time,a.name AS reference
      FROM bank_reconciliation_entry b JOIN ledger_account a ON a.organization_id=b.organization_id AND a.id=b.ledger_account_id
      WHERE b.organization_id=${org}::uuid AND b.action='MATCH'` : provider === "INVENTORY" ? Prisma.sql`
      SELECT s.id,s.received_at AS source_time,i.key AS reference
      FROM inventory_stocktake s JOIN inventory_item i ON i.organization_id=s.organization_id AND i.id=s.item_id
      JOIN operation_task t ON t.organization_id=s.organization_id AND t.id=s.task_id AND t.property_id=s.property_id
      WHERE s.organization_id=${org}::uuid` : Prisma.sql`
      SELECT c.id,MIN(t.created_at) AS source_time,r.purpose AS reference
      FROM employee_compensation_claim c JOIN employee_compensation_submission s ON s.organization_id=c.organization_id AND s.id=c.submission_id
      JOIN employee_compensation_run r ON r.organization_id=c.organization_id AND r.id=s.run_id
      JOIN employee_compensation_recognition n ON n.organization_id=c.organization_id AND n.claim_id=c.id
      JOIN employee_compensation_recognition_line l ON l.organization_id=n.organization_id AND l.recognition_id=n.id
      JOIN financial_transaction t ON t.organization_id=l.organization_id AND t.id=l.transaction_id
      WHERE c.organization_id=${org}::uuid GROUP BY c.id,r.purpose`;
    return this.tx.$queryRaw<VarianceCenterCandidate[]>(Prisma.sql`
      WITH native_roots AS (${roots})
      SELECT id,to_char(source_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,reference
      FROM native_roots ${after ? Prisma.sql`WHERE (source_time,id)>(${after.at}::timestamptz,${after.id}::uuid)` : Prisma.empty}
      ORDER BY source_time ASC,id ASC LIMIT 21`);
  }
}
