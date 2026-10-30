import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

const lineFields = { id: true, taskId: true, personId: true, assignmentId: true, compensationId: true, configRuleId: true,
  completionEventId: true, propertyId: true, recordedCompletionAt: true, rate: true, amount: true, currency: true,
  property: { select: { cityId: true, regionId: true } } } as const;
const include = { lines: { orderBy: { id: "asc" as const }, select: lineFields }, cancellation: true } satisfies Prisma.EmployeeCompensationRunInclude;
export type CompensationRunRecord = Prisma.EmployeeCompensationRunGetPayload<{ include: typeof include }>;

export class EmployeeCompensationRunRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async lockKey(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":employee-compensation-run-key:" + key},0))::text`);
  }
  async lock(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":employee-compensation-run:" + id},0))::text`);
  }
  find(id: string) { return this.tx.employeeCompensationRun.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  byKey(idempotencyKey: string) { return this.tx.employeeCompensationRun.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include }); }
  create(input: Omit<Prisma.EmployeeCompensationRunUncheckedCreateInput, "organizationId" | "lines" | "cancellation">) {
    return this.tx.employeeCompensationRun.create({ data: { ...input, organizationId: this.organizationId } });
  }
  createLines(runId: string, lines: ReadonlyArray<Omit<Prisma.EmployeeCompensationRunLineCreateManyInput, "organizationId" | "runId">>) {
    return this.tx.employeeCompensationRunLine.createMany({ data: lines.map(line => ({ ...line, organizationId: this.organizationId, runId })) });
  }
  cancel(runId: string, cancelledBy: string, reason: string) {
    return this.tx.employeeCompensationRunCancellation.create({ data: { organizationId: this.organizationId, runId, cancelledBy, reason } });
  }
  async window(fromOn: string, toOn: string, timezone: string) {
    const [row] = await this.tx.$queryRaw<Array<{ startsAt: Date; endsAt: Date }>>(Prisma.sql`SELECT
      (${fromOn}::date::timestamp AT TIME ZONE ${timezone}) AS "startsAt", ((${toOn}::date+1)::timestamp AT TIME ZONE ${timezone}) AS "endsAt"`);
    return row;
  }
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
}
