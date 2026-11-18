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
  canViewFinances: boolean;
};


function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class OwnerPortalRepository extends LedgerCalendarRepository {
  async listAccessForUser(userAccountId: string): Promise<{
    ownerIds: string[];
    propertyIds: string[];
    financialPropertyIds: string[];
  }> {
    const rows = await this.ownerPropertyAccessRows(userAccountId);

    return {
      ownerIds: unique(rows.map((row) => row.ownerId)),
      propertyIds: unique(rows.map((row) => row.propertyId)),
      financialPropertyIds: unique(rows.filter((row) => row.canViewFinances).map((row) => row.propertyId))
    };
  }

  async listOwnerProperties(userAccountId: string): Promise<OwnerPropertyRow[]> {
    return this.ownerPropertyAccessRows(userAccountId);
  }

  async findOwnerPropertyAccess(
    userAccountId: string,
    propertyId: string,
    financialOnly = false
  ): Promise<OwnerPropertyRow | null> {
    const rows = await this.ownerPropertyAccessRows(userAccountId, propertyId, financialOnly);
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
        JOIN active_owner_portal_access a ON a.organization_id = p.organization_id AND a.owner_id = o.id
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

  private ownerPropertyAccessRows(userAccountId: string, propertyId?: string, financialOnly = false) {
    const target = propertyId ? Prisma.sql`AND p.id = ${propertyId}::uuid` : Prisma.empty;
    const capability = financialOnly ? Prisma.sql`AND access.can_view_finances` : Prisma.empty;
    return this.tx.$queryRaw<OwnerPropertyRow[]>(Prisma.sql`
      SELECT o.id AS "ownerId", o.display_name AS "ownerName", p.id AS "propertyId", p.name AS "propertyName",
        p.city, link.share_bps AS "shareBps", access.can_view_finances AS "canViewFinances"
      FROM active_owner_portal_access access
      JOIN owner o ON o.organization_id = access.organization_id AND o.id = access.owner_id
      JOIN property_owner link ON link.organization_id = access.organization_id AND link.owner_id = access.owner_id
        AND link.archived_at IS NULL
      JOIN property p ON p.organization_id = link.organization_id AND p.id = link.property_id AND p.archived_at IS NULL
      WHERE access.organization_id = ${this.organizationId}::uuid AND access.user_account_id = ${userAccountId}::uuid
        ${target} ${capability}
      ORDER BY p.name, access.created_at, o.id, p.id`);
  }
}
