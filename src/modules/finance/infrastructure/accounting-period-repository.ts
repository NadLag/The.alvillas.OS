import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { accountingPeriodPolicyKey, accountingPeriodPolicySchema, accountingPeriodSnapshotSchema,
  AccountingPeriodClosedError, AccountingPeriodPolicyError } from "../domain/accounting-period";
import { calendarDateStart } from "@/platform/time/calendar";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";

const monthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
export class AccountingPeriodRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async lock() {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":accounting-period"},0))::text`);
  }
  async postingOpen(occurredAt: Date) {
    const [row] = await this.tx.$queryRaw<Array<{ open: boolean }>>(Prisma.sql`SELECT app_financial_period_is_open(${this.organizationId}::uuid,${occurredAt}::timestamptz) AS open`);
    return row.open;
  }
  async assertPostingOpen(occurredAt: Date) {
    if (!await this.postingOpen(occurredAt)) throw new AccountingPeriodClosedError();
  }
  async sourceInstant(occurredOn: Date, timezone: string) {
    const [row] = await this.tx.$queryRaw<Array<{ at: Date }>>(Prisma.sql`SELECT ${occurredOn.toISOString().slice(0,10)}::date::timestamp AT TIME ZONE ${timezone} AS at`);
    return row.at;
  }
  postingPeriod(occurredAt: Date) {
    return this.tx.accountingPeriod.findFirst({ where: { organizationId: this.organizationId, startsAt: { lte: occurredAt }, endsAt: { gt: occurredAt } },
      select: { id: true, month: true, timezone: true, events: { orderBy: { version: "desc" }, take: 1,
        select: { id: true, version: true, kind: true, reopensUntil: true } } } });
  }
  async policy(now: Date) {
    try {
      const row = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({ key: accountingPeriodPolicyKey,
        scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
      return row ? { id: row.id, version: row.version, value: accountingPeriodPolicySchema.parse(row.value) } : null;
    } catch (error) { if (error instanceof ZodError) throw new AccountingPeriodPolicyError(); throw error; }
  }
  async bounds(month: string, timezone: string) {
    // Existing period and expense instants remain authoritative historical data.
    // New calendars must agree with the application's current timezone data.
    requireCurrentTimezoneData();
    const next=monthDate(month);next.setUTCMonth(next.getUTCMonth()+1);
    const expectedStart=calendarDateStart(month+"-01",timezone),expectedEnd=calendarDateStart(next.toISOString().slice(0,10),timezone);
    const [row] = await this.tx.$queryRaw<Array<{ startsAt: Date; endsAt: Date }>>(Prisma.sql`SELECT
      (${month + "-01"}::date::timestamp AT TIME ZONE ${timezone}) AS "startsAt",
      ((${month + "-01"}::date::timestamp+interval '1 month') AT TIME ZONE ${timezone}) AS "endsAt"`);
    if(row.startsAt.getTime()!==expectedStart.getTime()||row.endsAt.getTime()!==expectedEnd.getTime())throw new AccountingPeriodPolicyError("timezoneData");
    return row;
  }
  period(id: string) { return this.tx.accountingPeriod.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } } }); }
  byMonth(month: string) { return this.tx.accountingPeriod.findUnique({ where: { organizationId_month: { organizationId: this.organizationId, month: monthDate(month) } } }); }
  eventByKey(idempotencyKey: string) { return this.tx.accountingPeriodEvent.findUnique({ where: {
    organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include: { period: true } }); }
  latest(periodId: string) { return this.tx.accountingPeriodEvent.findFirst({ where: { organizationId: this.organizationId, periodId }, orderBy: { version: "desc" } }); }
  list(after?: string) { return this.tx.accountingPeriod.findMany({ where: { organizationId: this.organizationId,
    ...(after ? { month: { lt: monthDate(after) } } : {}) }, orderBy: { month: "desc" }, take: 51,
    include: { events: { orderBy: { version: "desc" }, take: 1 } } }); }
  history(periodId: string, after?: number) { return this.tx.accountingPeriodEvent.findMany({ where: { organizationId: this.organizationId, periodId,
    ...(after ? { version: { lt: after } } : {}) }, orderBy: { version: "desc" }, take: 51,
    include: { creator: { select: { person: { select: { displayName: true } } } }, policy: { select: { version: true } } } }); }
  createPeriod(input: { month: string; timezone: string; startsAt: Date; endsAt: Date; policyRuleId: string; createdBy: string }) {
    return this.tx.accountingPeriod.create({ data: { ...input, month: monthDate(input.month), organizationId: this.organizationId } });
  }
  createEvent(input: { periodId: string; version: number; kind: string; reason: string; idempotencyKey: string;
    previousEventId: string | null; reopenSeconds: number | null; policyRuleId: string; snapshot: Prisma.InputJsonObject; createdBy: string }) {
    return this.tx.accountingPeriodEvent.create({ data: { ...input, organizationId: this.organizationId } });
  }
  async auditDeadline(eventId: string) {
    const [row] = await this.tx.$queryRaw<Array<{ deadline: string | null }>>(Prisma.sql`SELECT
      to_char(reopens_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline
      FROM accounting_period_event WHERE organization_id=${this.organizationId}::uuid AND id=${eventId}::uuid`);
    if (!row) throw Error("Accounting period event is unavailable");
    return row.deadline;
  }
  async snapshot(startsAt: Date, endsAt: Date) {
    const [row] = await this.tx.$queryRaw<Array<{ snapshot: unknown }>>(Prisma.sql`SELECT app_accounting_period_snapshot(${this.organizationId}::uuid,${startsAt}::timestamptz,${endsAt}::timestamptz) AS snapshot`);
    return accountingPeriodSnapshotSchema.parse(row.snapshot);
  }
}
