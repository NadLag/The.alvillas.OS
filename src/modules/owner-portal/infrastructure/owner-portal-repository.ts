import { Prisma } from "@prisma/client";
import { OwnerStatementRepository } from "@/platform/ledger/owner-statement-repository";
import type { RawOwnerLedgerPosting } from "@/modules/owner-portal/domain/owner-statement";
import { LedgerCalendarRepository } from "@/platform/ledger/ledger-calendar-repository";

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

export class OwnerPortalRepository extends LedgerCalendarRepository {
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
    const rows = await this.ownerPropertyAccessRows(userAccountId, propertyId);
    return rows.find((row) => row.propertyId === propertyId) ?? null;
  }


  async conditionSignals(userAccountId: string, propertyIds: readonly string[]) {
    if (!propertyIds.length) return [];
    return this.tx.$queryRaw<Array<{ propertyId: string; openIssue: boolean; waitingForWork: boolean }>>(Prisma.sql`
      WITH permitted AS (
        SELECT DISTINCT p.id
        FROM property p
        JOIN property_owner po ON po.organization_id = p.organization_id AND po.property_id = p.id AND po.archived_at IS NULL
        JOIN owner o ON o.organization_id = p.organization_id AND o.id = po.owner_id AND o.archived_at IS NULL
        JOIN owner_portal_access a ON a.organization_id = p.organization_id AND a.owner_id = o.id AND a.archived_at IS NULL
        JOIN user_account u ON u.organization_id = a.organization_id AND u.id = a.user_account_id AND u.status = 'ACTIVE'
        WHERE p.organization_id = ${this.organizationId}::uuid AND p.archived_at IS NULL
          AND a.user_account_id = ${userAccountId}::uuid AND p.id = ANY(${[...propertyIds]}::uuid[])
      ), issue_signals AS (
        SELECT i.property_id, bool_or(NOT EXISTS (
          SELECT 1 FROM maintenance_work_order w
          JOIN operation_task repair ON repair.organization_id = w.organization_id AND repair.id = w.id
          WHERE w.organization_id = i.organization_id AND w.issue_id = i.id
            AND repair.property_id = i.property_id AND repair.type = 'MAINTENANCE'
            AND repair.archived_at IS NULL AND repair.state = 'IN_PROGRESS'
        )) AS awaiting
        FROM permitted p JOIN operation_issue i ON i.property_id = p.id
        JOIN operation_task t ON t.organization_id = i.organization_id AND t.id = i.task_id AND t.archived_at IS NULL
        WHERE i.organization_id = ${this.organizationId}::uuid AND i.state IN ('OPEN', 'IN_PROGRESS')
        GROUP BY i.property_id
      )
      SELECT p.id AS "propertyId", i.property_id IS NOT NULL AS "openIssue",
        coalesce(i.awaiting, false) AS "waitingForWork"
      FROM permitted p LEFT JOIN issue_signals i ON i.property_id = p.id`);
  }

  listOwnerLedgerPostings(input:Parameters<OwnerStatementRepository["listOwnerLedgerPostings"]>[0]):Promise<RawOwnerLedgerPosting[]>{return new OwnerStatementRepository(this.tx,this.organizationId).listOwnerLedgerPostings(input)}

  async reservationCalendar(propertyId: string) {
    const [[clock], property] = await Promise.all([
      this.tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`,
      this.tx.property.findFirst({ where: { organizationId: this.organizationId, id: propertyId, archivedAt: null },
        select: { timezone: true } })
    ]);
    return property ? { now: clock.now, timezone: property.timezone } : null;
  }

  reservations(propertyId: string, from: Date, until?: Date, cursor?: { day: Date; id: string }, reservationId?: string) {
    return this.tx.reservation.findMany({
      where: { organizationId: this.organizationId, propertyId, id: reservationId, archivedAt: null,
        ...(reservationId ? {} : { checkOut: { gt: from } }),
        ...(until ? { checkIn: { lte: until } } : {}),
        ...(cursor ? { OR: [{ checkIn: { gt: cursor.day } }, { checkIn: cursor.day, id: { gt: cursor.id } }] } : {}) },
      select: { id: true, reference: true, checkIn: true, checkOut: true, status: true },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }], take: 31
    });
  }

  private async ownerPropertyAccessRows(userAccountId: string, propertyId?: string): Promise<OwnerPropertyRow[]> {
    const rows = await this.tx.ownerPortalAccess.findMany({
      where: {
        organizationId: this.organizationId,
        userAccountId,
        userAccount: { status: "ACTIVE", organizationId: this.organizationId },
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
                propertyId,
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
