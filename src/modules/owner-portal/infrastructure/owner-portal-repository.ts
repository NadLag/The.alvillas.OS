import { OwnerStatementRepository } from "@/platform/ledger/owner-statement-repository";
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

  listOwnerLedgerPostings(input:Parameters<OwnerStatementRepository["listOwnerLedgerPostings"]>[0]):Promise<RawOwnerLedgerPosting[]>{return new OwnerStatementRepository(this.tx,this.organizationId).listOwnerLedgerPostings(input)}

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
