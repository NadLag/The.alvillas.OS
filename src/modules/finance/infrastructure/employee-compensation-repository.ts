import type { TenantTransaction } from "@/platform/db/tenant";
import type { Prisma } from "@prisma/client";

const assignmentFields = { id: true, personId: true, roleId: true, scopeType: true, scopeId: true, validFrom: true, validTo: true, archivedAt: true,
  person: { select: { archivedAt: true } }, role: { select: { key: true } } } as const;
const rateFields = { id: true, configRuleId: true, version: true, mode: true, amount: true, currency: true, effectiveFrom: true } as const;
const propertyFields = { id: true, cityId: true, regionId: true } as const;
const completedWorkFields = (organizationId: string) => ({
  id: true, propertyId: true, requiredRoleKey: true, version: true, state: true, completedAt: true, completedByPersonId: true,
  completedByUserAccountId: true, completionSource: true, completionIdempotencyKey: true,
  validatedByPersonId: true, validatedByUserAccountId: true, validatedAt: true, validationReason: true,
  property: { select: propertyFields },
  checklistItems: { orderBy: { sortOrder: "asc" }, select: { id: true, completedAt: true, completedByPersonId: true, completedByUserAccountId: true } },
  events: { where: { organizationId, kind: "CHANGED", after: { path: ["state"], equals: "COMPLETED" },
    NOT: { before: { path: ["state"], equals: "COMPLETED" } } }, orderBy: { version: "asc" }, take: 2,
    select: { id: true, organizationId: true, taskId: true, version: true, actorId: true, before: true, after: true } }
} satisfies Prisma.OperationTaskSelect);

/** Read the canonical identity contract; employee payables never maintain a second rate table. */
export class EmployeeCompensationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  originalContracts(ids:readonly string[]){return this.tx.teamCompensation.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{...rateFields,assignmentId:true}});}

  async source(assignmentId: string, earnedAt: Date) {
    const assignment = await this.tx.roleAssignment.findFirst({ where: { organizationId: this.organizationId, id: assignmentId },
      select: { ...assignmentFields, teamCompensations: { where: { organizationId: this.organizationId, effectiveFrom: { lte: earnedAt } },
          orderBy: { version: "desc" }, take: 1, select: rateFields } } });
    if (!assignment) return null;
    const job = assignment.scopeType === "job" && assignment.scopeId ? await this.tx.operationTask.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { propertyId: true, reservationId: true } }) : null;
    const propertyId = assignment.scopeType === "property" ? assignment.scopeId : job?.propertyId;
    const property = propertyId ? await this.tx.property.findFirst({ where: { organizationId: this.organizationId, id: propertyId },
      select: propertyFields }) : null;
    const city = assignment.scopeType === "city" && assignment.scopeId ? await this.tx.city.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { id: true, regionId: true } }) : null;
    const region = assignment.scopeType === "region" && assignment.scopeId ? await this.tx.region.findFirst({
      where: { organizationId: this.organizationId, id: assignment.scopeId }, select: { id: true } }) : null;
    return { assignment, property, job, city, region, rate: assignment.teamCompensations.at(0) ?? null };
  }

  /** Select canonical effective-dated contracts for a run without one query chain per job. */
  async sources(entries: readonly { key: string; assignmentId: string; earnedAt: Date }[]) {
    type Source = Awaited<ReturnType<EmployeeCompensationRepository["source"]>>;
    const result = new Map<string, Source>();
    if (!entries.length) return result;
    if (new Set(entries.map(entry => entry.key)).size !== entries.length || entries.some(entry => !Number.isFinite(entry.earnedAt.getTime())))
      throw Error("Contract source identities and dates must be valid and distinct");
    const assignments = await this.tx.roleAssignment.findMany({ where: { organizationId: this.organizationId, id: { in: [...new Set(entries.map(entry => entry.assignmentId))] } },
      select: { ...assignmentFields, teamCompensations: { where: { organizationId: this.organizationId,
        effectiveFrom: { lte: new Date(entries.reduce((last, entry) => Math.max(last, entry.earnedAt.getTime()), -Infinity)) } }, orderBy: { version: "desc" }, select: rateFields } } });
    const scopeIds = (scope: string) => [...new Set(assignments.filter(assignment => assignment.scopeType === scope && assignment.scopeId).map(assignment => assignment.scopeId!))];
    const [jobs, cities, regions] = await Promise.all([
      this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: scopeIds("job") } }, select: { id: true, propertyId: true, reservationId: true } }),
      this.tx.city.findMany({ where: { organizationId: this.organizationId, id: { in: scopeIds("city") } }, select: { id: true, regionId: true } }),
      this.tx.region.findMany({ where: { organizationId: this.organizationId, id: { in: scopeIds("region") } }, select: { id: true } })
    ]);
    const properties = await this.tx.property.findMany({ where: { organizationId: this.organizationId,
      id: { in: [...new Set([...scopeIds("property"), ...jobs.map(job => job.propertyId)])] } }, select: propertyFields });
    const assignmentMap = new Map(assignments.map(row => [row.id, row])), jobMap = new Map(jobs.map(row => [row.id, row]));
    const propertyMap = new Map(properties.map(row => [row.id, row])), cityMap = new Map(cities.map(row => [row.id, row])), regionMap = new Map(regions.map(row => [row.id, row]));
    for (const entry of entries) {
      const candidate = assignmentMap.get(entry.assignmentId);
      if (!candidate) { result.set(entry.key, null); continue; }
      const rate = candidate.teamCompensations.find(row => row.effectiveFrom <= entry.earnedAt) ?? null;
      const assignment = { ...candidate, teamCompensations: rate ? [rate] : [] };
      const actualJob = assignment.scopeType === "job" && assignment.scopeId ? jobMap.get(assignment.scopeId) : null;
      const job = actualJob ? { propertyId: actualJob.propertyId, reservationId: actualJob.reservationId } : null;
      const propertyId = assignment.scopeType === "property" ? assignment.scopeId : job?.propertyId;
      result.set(entry.key, { assignment, rate, job, property: propertyId ? propertyMap.get(propertyId) ?? null : null,
        city: assignment.scopeType === "city" && assignment.scopeId ? cityMap.get(assignment.scopeId) ?? null : null,
        region: assignment.scopeType === "region" && assignment.scopeId ? regionMap.get(assignment.scopeId) ?? null : null });
    }
    return result;
  }

  completedWork(taskId: string) {
    return this.tx.operationTask.findFirst({ where: { organizationId: this.organizationId, id: taskId }, select: completedWorkFields(this.organizationId) });
  }
  completedWorks(taskIds: readonly string[]) {
    return this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: [...new Set(taskIds)] } }, select: completedWorkFields(this.organizationId) });
  }
}
