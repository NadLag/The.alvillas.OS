import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { RawOwnerLedgerPosting } from "./owner-statement";

type OwnerLedgerPostingRow = {
  id: string;
  transactionId: string;
  reference: string;
  occurredAt: Date;
  description: string | null;
  side: "DEBIT" | "CREDIT";
  amount: string;
  currency: string;
  bucket: string | null;
  dimensions: Prisma.JsonValue | null;
  locationName: string | null;
  locationCode: string | null;
  propertyName: string | null;
};

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

export class OwnerStatementRepository {
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async listOwnerLedgerPostings(input: {
    ownerId: string;
    propertyId?: string;
    periodEnd: Date;
    currency?: string;
    includeLocations?: boolean;
  }): Promise<RawOwnerLedgerPosting[]> {
    const rows = await this.tx.$queryRaw<OwnerLedgerPostingRow[]>(Prisma.sql`
      SELECT
        p.id,
        p.transaction_id AS "transactionId",
        ft.reference,
        ft.occurred_at AS "occurredAt",
        ft.description,
        p.side,
        p.amount::text AS amount,
        p.currency,
        p.bucket,
        p.dimensions,
        property.name AS "propertyName",
        ${input.includeLocations === false ? Prisma.sql`NULL::text AS "locationName", NULL::text AS "locationCode"` : Prisma.sql`location.name AS "locationName", location.code AS "locationCode"`}
      FROM posting p
      INNER JOIN ledger_account owner_account
        ON owner_account.id = p.ledger_account_id
       AND owner_account.organization_id = p.organization_id
      INNER JOIN financial_transaction ft
        ON ft.id = p.transaction_id
       AND ft.organization_id = p.organization_id
      LEFT JOIN property ON property.organization_id=p.organization_id AND property.id::text=p.dimensions->>'property_id'
      ${input.includeLocations === false ? Prisma.empty : Prisma.sql`LEFT JOIN LATERAL (
        SELECT location_account.name, location_account.code
        FROM posting location_posting
        INNER JOIN ledger_account location_account
          ON location_account.id = location_posting.ledger_account_id
         AND location_account.organization_id = location_posting.organization_id
        WHERE location_posting.organization_id = p.organization_id
          AND location_posting.transaction_id = p.transaction_id
          AND location_posting.id <> p.id
          AND location_account.account_type = 'ASSET_LOCATION'
        ORDER BY location_posting.created_at ASC, location_posting.id ASC
        LIMIT 1
      ) location ON true`}
      WHERE p.organization_id = ${this.organizationId}::uuid
        AND owner_account.code = 'OWNER_PAYABLE'
        AND owner_account.account_type = 'CLAIM_OWNERSHIP'
        AND p.dimensions @> jsonb_build_object('owner_id', ${input.ownerId})
        ${input.propertyId ? Prisma.sql`AND p.dimensions @> jsonb_build_object('property_id', ${input.propertyId})` : Prisma.empty}
        ${input.currency ? Prisma.sql`AND p.currency=${input.currency}` : Prisma.empty}
        AND ft.occurred_at < ${input.periodEnd}
      ORDER BY ft.occurred_at ASC, ft.reference ASC, p.id ASC
    `);

    return rows.map((row) => ({
      ...row,
      dimensions: jsonObject(row.dimensions)
    }));
  }

  async hasOwnerLedgerPropertyHistory(ownerId:string,propertyId:string):Promise<boolean>{
    const [row]=await this.tx.$queryRaw<Array<{found:boolean}>>(Prisma.sql`SELECT EXISTS(
      SELECT 1 FROM posting p JOIN ledger_account a ON a.id=p.ledger_account_id AND a.organization_id=p.organization_id
      JOIN financial_transaction ft ON ft.id=p.transaction_id AND ft.organization_id=p.organization_id
      WHERE p.organization_id=${this.organizationId}::uuid AND a.code='OWNER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP'
      AND p.dimensions @> jsonb_build_object('owner_id',${ownerId},'property_id',${propertyId})) AS found`);
    return row.found;
  }

}
