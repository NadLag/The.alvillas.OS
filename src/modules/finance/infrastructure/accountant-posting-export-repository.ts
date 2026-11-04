import { Prisma } from "@prisma/client";
import { LedgerCalendarRepository } from "./ledger-calendar-repository";
import type { AccountantExportPolicy } from "../domain/accountant-export-policy";

export type AccountantPostingSource = { id: string; transactionId: string; reference: string; occurredAt: string; description: string | null;
  accountId: string; accountCode: string; accountType: string; normalSide: "DEBIT" | "CREDIT"; side: "DEBIT" | "CREDIT"; amount: string; currency: string;
  bucket: string | null; propertyId: string | null; ownerId: string | null; supplierId: string | null; invoiceId: string | null;
  personId: string | null; claimId: string | null; reversesTransactionId: string | null; sourceValid: boolean };
type Classification = NonNullable<AccountantExportPolicy["classifications"]["income"]>;

/** Bounded immutable posting facts share one PostgreSQL statement; the extra row proves overflow rather than truncating it. */
export class AccountantPostingExportRepository extends LedgerCalendarRepository {
  async choices(kind: "property" | "owner", query: string, after?: string) {
    const where = { organizationId: this.organizationId, ...(after ? { id: { gt: after } } : {}) };
    return kind === "property"
      ? (await this.tx.property.findMany({ where: { ...where, name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, orderBy: { id: "asc" }, take: 31 })).map(row => ({ id: row.id, label: row.name }))
      : (await this.tx.owner.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy: { id: "asc" }, take: 31 })).map(row => ({ id: row.id, label: row.displayName }));
  }
  property(id: string) { return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id }, select: { id: true, name: true } }); }
  owner(id: string) { return this.tx.owner.findFirst({ where: { organizationId: this.organizationId, id }, select: { id: true, displayName: true, archivedAt: true } }); }
  accountCodes(codes: readonly string[]) { return this.tx.ledgerAccount.findMany({ where: { organizationId: this.organizationId, code: { in: [...codes] } }, select: { code: true, accountType: true, normalSide: true } }); }
  postings(input: { currency: string; startsAt: Date; endsAt: Date; maxRows: number; propertyId?: string; classification?: Classification }): Promise<AccountantPostingSource[]> {
    const classification = input.classification;
    return this.tx.$queryRaw<AccountantPostingSource[]>(Prisma.sql`
      WITH original AS MATERIALIZED (
        SELECT p.id,p.transaction_id,t.reference,t.occurred_at,t.description,t.reverses_transaction_id,p.side,p.amount,p.currency,p.bucket,
          a.id AS account_id,a.code AS account_code,a.account_type,a.normal_side,
          COALESCE(cash.property_id::text,p.dimensions->>'property_id') AS property_id,
          p.dimensions->>'owner_id' AS owner_id,p.dimensions->>'supplier_id' AS supplier_id,p.dimensions->>'supplier_invoice_id' AS invoice_id,
          COALESCE(p.dimensions->>'employee_person_id',p.dimensions->>'person_id') AS person_id,p.dimensions->>'employee_compensation_claim_id' AS claim_id,
          (cash.property_id IS NULL OR p.dimensions->>'property_id' IS NULL OR cash.property_id::text=p.dimensions->>'property_id') AS native_property_consistent
        FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
        JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
        LEFT JOIN cash_collection cash ON cash.organization_id=p.organization_id AND cash.transaction_id=COALESCE(t.reverses_transaction_id,t.id)
        WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency} AND t.sealed
          AND t.occurred_at>=${input.startsAt} AND t.occurred_at<${input.endsAt}
          ${input.propertyId ? Prisma.sql`AND COALESCE(cash.property_id::text,p.dimensions->>'property_id')=${input.propertyId}` : Prisma.empty}
          ${classification ? Prisma.sql`AND p.bucket IN (${Prisma.join(classification.buckets)}) AND (p.side IN (${Prisma.join(classification.sides)}) OR EXISTS(
            SELECT 1 FROM posting opposite WHERE opposite.organization_id=p.organization_id AND opposite.transaction_id=t.reverses_transaction_id
              AND opposite.ledger_account_id=p.ledger_account_id AND opposite.currency=p.currency AND opposite.amount=p.amount
              AND opposite.side<>p.side AND opposite.bucket IN (${Prisma.join(classification.buckets)}) AND opposite.side IN (${Prisma.join(classification.sides)})))
            AND a.account_type IN (${Prisma.join(classification.account_types)})
            ${classification.account_codes ? Prisma.sql`AND a.code IN (${Prisma.join(classification.account_codes)})` : Prisma.empty}` : Prisma.empty}
        ORDER BY t.occurred_at,t.id,p.id LIMIT ${input.maxRows + 1}
      ) SELECT o.id,o.transaction_id AS "transactionId",o.reference,to_char(o.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
        o.description,o.account_id AS "accountId",o.account_code AS "accountCode",o.account_type AS "accountType",o.normal_side AS "normalSide",o.side,o.amount::text,o.currency,o.bucket,
        o.property_id AS "propertyId",o.owner_id AS "ownerId",o.supplier_id AS "supplierId",o.invoice_id AS "invoiceId",o.person_id AS "personId",o.claim_id AS "claimId",o.reverses_transaction_id AS "reversesTransactionId",
        (o.native_property_consistent
          AND (o.property_id IS NULL OR EXISTS(SELECT 1 FROM property x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.property_id))
          AND (o.owner_id IS NULL OR EXISTS(SELECT 1 FROM owner x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.owner_id))
          AND (o.supplier_id IS NULL OR EXISTS(SELECT 1 FROM supplier x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.supplier_id))
          AND (o.invoice_id IS NULL OR EXISTS(SELECT 1 FROM supplier_invoice x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.invoice_id AND (o.supplier_id IS NULL OR x.supplier_id::text=o.supplier_id)))
          AND (o.person_id IS NULL OR EXISTS(SELECT 1 FROM person x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.person_id))
          AND (o.claim_id IS NULL OR EXISTS(SELECT 1 FROM employee_compensation_claim x WHERE x.organization_id=${this.organizationId}::uuid AND x.id::text=o.claim_id AND (o.person_id IS NULL OR x.person_id::text=o.person_id)))) AS "sourceValid"
      FROM original o ORDER BY o.occurred_at,o.transaction_id,o.id`);
  }
}
