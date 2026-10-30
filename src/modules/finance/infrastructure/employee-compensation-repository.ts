import type { TenantTransaction } from "@/platform/db/tenant";

/** Read the canonical identity contract; employee payables never maintain a second rate table. */
export class EmployeeCompensationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async source(assignmentId: string, earnedAt: Date) {
    const assignment = await this.tx.roleAssignment.findFirst({ where: { organizationId: this.organizationId, id: assignmentId },
      select: { id: true, personId: true, roleId: true, scopeType: true, scopeId: true, validFrom: true, validTo: true, archivedAt: true,
        person: { select: { archivedAt: true } }, teamCompensations: { where: { organizationId: this.organizationId, effectiveFrom: { lte: earnedAt } },
          orderBy: { version: "desc" }, take: 1, select: { id: true, configRuleId: true, version: true, mode: true, amount: true, currency: true, effectiveFrom: true } } } });
    if (!assignment) return null;
    const job = assignment.scopeType === "job" && assignment.scopeId ? await this.tx.operationTask.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { propertyId: true, reservationId: true } }) : null;
    const propertyId = assignment.scopeType === "property" ? assignment.scopeId : job?.propertyId;
    const property = propertyId ? await this.tx.property.findFirst({ where: { organizationId: this.organizationId, id: propertyId },
      select: { id: true, cityId: true, regionId: true } }) : null;
    const city = assignment.scopeType === "city" && assignment.scopeId ? await this.tx.city.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { id: true, regionId: true } }) : null;
    const region = assignment.scopeType === "region" && assignment.scopeId ? await this.tx.region.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { id: true } }) : null;
    return { assignment, property, job, city, region, rate: assignment.teamCompensations[0] ?? null };
  }
}
