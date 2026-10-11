import { Prisma } from "@prisma/client";
import type { RawOwnerLedgerPosting } from "@/modules/owner-portal/domain/owner-statement";
import type { TenantTransaction } from "@/platform/db/tenant";

type OwnerPropertyRow = {
  ownerId: string;
  ownerName: string;
  propertyId: string;
  propertyName: string;
  city: string;
  shareBps: number;
};

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
};

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ownerPropertyRows(
  rows: Array<{
    ownerId: string;
    ownerName: string;
    propertyOwners: Array<{
      shareBps: number;
      property: {
        id: string;
        name: string;
        city: string;
      };
    }>;
  }>
): OwnerPropertyRow[] {
  return rows.flatMap((access) =>
    access.propertyOwners.map((link) => ({
      ownerId: access.ownerId,
      ownerName: access.ownerName,
      propertyId: link.property.id,
      propertyName: link.property.name,
      city: link.property.city,
      shareBps: link.shareBps
    }))
  );
}

export class OwnerPortalRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async listAccessForUser(userAccountId: string): Promise<{
    ownerIds: string[];
    propertyIds: string[];
  }> {
    const rows = await this.ownerPropertyAccessRows(userAccountId);

    return {
      ownerIds: unique(rows.map((row) => row.ownerId)),
      propertyIds: unique(rows.map((row) => row.propertyId))
    };
  }

  async listOwnerProperties(userAccountId: string): Promise<OwnerPropertyRow[]> {
    return this.ownerPropertyAccessRows(userAccountId);
  }

  async findOwnerPropertyAccess(
    userAccountId: string,
    propertyId: string
  ): Promise<OwnerPropertyRow | null> {
    const rows = await this.ownerPropertyAccessRows(userAccountId);
    return rows.find((row) => row.propertyId === propertyId) ?? null;
  }

  async listOwnerLedgerPostings(input: {
    ownerId: string;
    propertyId: string;
    periodEnd: Date;
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
        location.name AS "locationName",
        location.code AS "locationCode"
      FROM posting p
      INNER JOIN ledger_account owner_account
        ON owner_account.id = p.ledger_account_id
       AND owner_account.organization_id = p.organization_id
      INNER JOIN financial_transaction ft
        ON ft.id = p.transaction_id
       AND ft.organization_id = p.organization_id
      LEFT JOIN LATERAL (
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
      ) location ON true
      WHERE p.organization_id = ${this.organizationId}::uuid
        AND owner_account.code = 'OWNER_PAYABLE'
        AND p.dimensions @> jsonb_build_object(
          'owner_id', ${input.ownerId},
          'property_id', ${input.propertyId}
        )
        AND ft.occurred_at < ${input.periodEnd}
      ORDER BY ft.occurred_at ASC, ft.reference ASC, p.id ASC
    `);

    return rows.map((row) => ({
      ...row,
      dimensions: jsonObject(row.dimensions)
    }));
  }

  private async ownerPropertyAccessRows(userAccountId: string): Promise<OwnerPropertyRow[]> {
    const rows = await this.tx.ownerPortalAccess.findMany({
      where: {
        organizationId: this.organizationId,
        userAccountId,
        archivedAt: null,
        owner: {
          archivedAt: null
        }
      },
      include: {
        owner: {
          include: {
            propertyOwners: {
              where: {
                archivedAt: null,
                property: {
                  archivedAt: null
                }
              },
              include: {
                property: true
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        }
      },
      orderBy: [{ createdAt: "asc" }]
    });

    return ownerPropertyRows(
      rows.map((row) => ({
        ownerId: row.owner.id,
        ownerName: row.owner.displayName,
        propertyOwners: row.owner.propertyOwners
      }))
    ).sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  }
}
