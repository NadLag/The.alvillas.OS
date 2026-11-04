import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export type AccountantPaymentPosting = { id: string; transactionId: string; reference: string; occurredAt: string; description: string | null;
  reversesTransactionId: string | null; createdBy: string | null; sealed: boolean; accountId: string; accountCode: string; accountType: string;
  normalSide: "DEBIT" | "CREDIT"; side: "DEBIT" | "CREDIT"; amount: string; currency: string; bucket: string | null; dimensions: Prisma.JsonValue };
type Range = { startsAt: Date; endsAt: Date; currency: string; maxRows: number };

/** Select complete native payment legs, never a reconstructed expense or a mutable outstanding balance. */
export class AccountantPaymentExportRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  postings(kind: "SUPPLIER_PAYMENTS" | "STAFF_PAYMENTS", range: Range, originalIds?: string[]): Promise<AccountantPaymentPosting[]> {
    const buckets = kind === "SUPPLIER_PAYMENTS" ? ["SUPPLIER_PAYMENT"] : ["EMPLOYEE_PAYMENT", "COMPENSATION_OFFSET"];
    return this.tx.$queryRaw<AccountantPaymentPosting[]>(Prisma.sql`
      SELECT p.id,p.transaction_id AS "transactionId",t.reference,
        to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",t.description,
        t.reverses_transaction_id AS "reversesTransactionId",t.created_by AS "createdBy",t.sealed,
        a.id AS "accountId",a.code AS "accountCode",a.account_type AS "accountType",a.normal_side AS "normalSide",
        p.side,p.amount::text,p.currency,p.bucket,p.dimensions
      FROM financial_transaction t JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
      JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      WHERE t.organization_id=${this.organizationId}::uuid
        ${originalIds ? Prisma.sql`AND t.id IN (${Prisma.join(originalIds.map(id => Prisma.sql`${id}::uuid`))})`
          : Prisma.sql`AND t.occurred_at>=${range.startsAt} AND t.occurred_at<${range.endsAt}
            AND EXISTS(SELECT 1 FROM posting source WHERE source.organization_id=t.organization_id AND source.transaction_id=t.id
              AND source.currency=${range.currency} AND source.bucket IN (${Prisma.join(buckets)}))`}
      ORDER BY t.occurred_at,t.id,p.id LIMIT ${range.maxRows + 1}`);
  }
  audits(ids: string[], kind: "SUPPLIER_PAYMENTS" | "STAFF_PAYMENTS") {
    const prefix = kind === "SUPPLIER_PAYMENTS" ? "finance.supplier_payment" : "finance.employee_settlement";
    return this.tx.auditLog.findMany({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: { in: ids },
      action: { in: [prefix + ".posted", prefix + ".reversed"] } }, orderBy: { id: "asc" },
      select: { id: true, resourceId: true, actorId: true, action: true, reason: true, after: true } });
  }
  supplierRecognitions(ids: string[]) {
    return this.tx.supplierInvoiceRecognition.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, orderBy: { id: "asc" },
      select: { id: true, invoiceId: true, submissionId: true, invoice: { select: { supplierId: true, supplier: { select: { displayName: true } } } },
        submission: { select: { invoiceId: true, revision: { select: { invoiceId: true, invoiceNumber: true, currency: true } } } } } });
  }
  staffRecognitions(ids: string[]) {
    return this.tx.employeeCompensationRecognition.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, orderBy: { id: "asc" },
      select: { id: true, submissionId: true, claimId: true, claim: { select: { submissionId: true, personId: true, person: { select: { displayName: true } } } } } });
  }
}
