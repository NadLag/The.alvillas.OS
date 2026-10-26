import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthContext } from "@/platform/authz/authorize";
import { terminalTaskStates } from "../domain/operation-task";
import { fieldPullPageSize, type FieldPullInput } from "../domain/field-pull";
import { dateToUtc } from "../domain/reservation-task";
import { fieldTaskReadWhere } from "./field-task-scope";

const metadataSelect = {
  id: true, propertyId: true, reservationId: true, state: true, dueDate: true, updatedAt: true, version: true,
  assignedToUserAccountId: true, assignedToPersonId: true,
  assignedToPerson: { select: { displayName: true, updatedAt: true, archivedAt: true } },
  property: { select: { city: true, cityId: true, region: true, regionId: true, timezone: true, updatedAt: true } },
  reservation: { select: { updatedAt: true, guestId: true } }
} satisfies Prisma.OperationTaskSelect;
const snapshotSelect = {
  ...metadataSelect, type: true, priority: true, titleTranslations: true,
  property: { select: { ...metadataSelect.property.select, name: true, addressLine1: true, addressLine2: true } },
  reservation: { select: { updatedAt: true, guestId: true, reference: true, guestName: true } },
  checklistItems: { select: { id: true, key: true, labelTranslations: true, completedAt: true }, orderBy: { sortOrder: "asc" } }
} satisfies Prisma.OperationTaskSelect;
export type FieldPullMetadata = Prisma.OperationTaskGetPayload<{ select: typeof metadataSelect }>;
export type FieldPullSnapshotRecord = Prisma.OperationTaskGetPayload<{ select: typeof snapshotSelect }>;

export class FieldPullRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async snapshotTime(): Promise<Date> {
    const [row] = await this.tx.$queryRaw<Array<{ at: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`;
    return row.at;
  }
  private scope(actorId: string, auth: AuthContext, now: Date, mode: FieldPullInput["mode"]): Prisma.OperationTaskWhereInput {
    if (mode === "supervised") {
      if (!auth.personId) return { organizationId: this.organizationId, OR: [] };
      return { organizationId: this.organizationId, archivedAt: null, state: { in: ["ASSIGNED", "IN_PROGRESS"] },
        assignedToPersonId: { not: auth.personId }, assignedToPerson: { is: { archivedAt: null } },
        AND: [fieldTaskReadWhere(auth, now), fieldTaskReadWhere(auth, now, "validate")],
        OR: [{ assignedToUserAccountId: null }, { assignedToUserAccountId: { not: actorId } }] };
    }
    return { organizationId: this.organizationId, assignedToUserAccountId: actorId, archivedAt: null,
      state: { notIn: [...terminalTaskStates] }, AND: [fieldTaskReadWhere(auth, now)] };
  }
  page(actorId: string, auth: AuthContext, now: Date, asOf: Date, input: FieldPullInput, after: { date: string; id: string } | null) {
    // Every IANA calendar date is at most tomorrow relative to the UTC date.
    // Per-property calendar checks happen before returning any record.
    const upperDate = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() + 1));
    return this.tx.operationTask.findMany({ where: { AND: [
      this.scope(actorId, auth, now, input.mode), { createdAt: { lt: new Date(asOf.getTime() + 1) } },
      ...(input.mode === "today" ? [{ dueDate: { lte: upperDate } }] : []),
      ...(input.property_id ? [{ propertyId: input.property_id }] : []),
      ...(after ? [{ OR: [
        { dueDate: { gt: dateToUtc(after.date) } }, { dueDate: dateToUtc(after.date), id: { gt: after.id } }
      ] }] : [])]
    }, select: metadataSelect, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: fieldPullPageSize + 1 });
  }
  known(actorId: string, auth: AuthContext, now: Date, ids: string[], mode: FieldPullInput["mode"]) {
    return this.tx.operationTask.findMany({ where: { AND: [this.scope(actorId, auth, now, mode), { id: { in: ids } }] }, select: metadataSelect });
  }
  snapshots(actorId: string, auth: AuthContext, now: Date, ids: string[], mode: FieldPullInput["mode"]) {
    return this.tx.operationTask.findMany({ where: { AND: [this.scope(actorId, auth, now, mode), { id: { in: ids } }] }, select: snapshotSelect });
  }
}
