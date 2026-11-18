import { z } from "zod";
import { calendarDateAt } from "@/i18n/format";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource, authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import { propertyFinanceAuthorityChecks } from "@/platform/authz/property-finance-resource";
import { companyReportSources, inventoryReportSources, kpiReportSources, teamReportSources } from "./report-source-scope";
import { kpiDimensionSchema } from "./kpi-report";

export const reportSchedulesKey = "finance.report_schedules";
export const scheduledReportKinds = ["PROPERTY", "COMPANY", "TEAM", "INVENTORY", "KPI"] as const;
const channel = z.enum(["in_app", "email", "push"]);
const occurrence = z.discriminatedUnion("frequency", [
  z.strictObject({ frequency: z.literal("MONTHLY"), day: z.number().int().min(1).max(28) }),
  z.strictObject({ frequency: z.literal("WEEKLY"), day: z.number().int().min(1).max(7) })
]);
const distinct = (values: string[]) => new Set(values).size === values.length;
const scheduleSchema = z.strictObject({
  id: z.uuid(), kind: z.enum(scheduledReportKinds), propertyId: z.uuid().optional(), currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  recipients: z.array(z.uuid()).min(1).max(40).refine(distinct),
  starts_on: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  occurrence, channels: z.array(channel).min(1).max(3).refine(distinct),
  filters: kpiDimensionSchema.optional()
}).refine(value => (!value.filters || value.kind === "KPI") && (value.kind === "PROPERTY" ? Boolean(value.propertyId) :
  !value.propertyId || value.kind === "KPI" || value.kind === "INVENTORY"));

export const reportSchedulesPolicy = z.strictObject({
  schedules: z.array(scheduleSchema).max(25).refine(schedules => distinct(schedules.map(value => value.id)))
});
export type ScheduledReport = z.infer<typeof scheduleSchema>;
export type ScheduledReportKind = typeof scheduledReportKinds[number];
export type ScheduledChannels = ScheduledReport["channels"];

function shiftDays(on: string, shift: number) {
  const cursor = new Date(on + "T00:00:00Z");
  cursor.setUTCDate(cursor.getUTCDate() + shift);
  return cursor.toISOString().slice(0, 10);
}
function previousMonth(on: string) {
  const cursor = new Date(on.slice(0, 7) + "-01T00:00:00Z");
  cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  return cursor.toISOString().slice(0, 7);
}
export function dueReportPeriod(schedule: ScheduledReport, now: Date, timezone: string) {
  const today = calendarDateAt(now, timezone);
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const through = hour >= schedule.time ? today : shiftDays(today, -1);
  const { day, frequency } = schedule.occurrence;
  if (frequency === "WEEKLY") {
    const weekday = (new Date(through + "T00:00:00Z").getUTCDay() || 7);
    const scheduledOn = shiftDays(through, -((weekday - day + 7) % 7));
    if (scheduledOn < schedule.starts_on) return null;
    const weekStart = shiftDays(scheduledOn, 1 - day);
    return { scheduledOn, fromOn: shiftDays(weekStart, -7), toOn: shiftDays(weekStart, -1) };
  }
  const localDay = String(day).padStart(2, "0");
  const candidate = through.slice(0, 7) + "-" + localDay;
  const scheduledOn = candidate <= through ? candidate : previousMonth(through) + "-" + localDay;
  if (scheduledOn < schedule.starts_on) return null;
  return { scheduledOn, fromOn: previousMonth(scheduledOn) + "-01", toOn: shiftDays(scheduledOn.slice(0, 7) + "-01", -1) };
}

export type ScheduledReportTarget = Resource & {
  reportRun: { kind: ScheduledReportKind; recipientId: string; fromOn: string; toOn: string; currency: string; filters: unknown };
};

export function canReadScheduledReport(context: AuthContext, target: Resource, at: Date): target is ScheduledReportTarget {
  const report = (target as Partial<ScheduledReportTarget>).reportRun;
  if (target.type !== "report" || !report || report.recipientId !== context.userAccountId) return false;
  const resource = { type: "report", id: target.propertyId ?? undefined, organizationId: target.organizationId,
    propertyId: target.propertyId, city: target.city, region: target.region, dataClass: "financial" as const };
  if (report.kind === "PROPERTY") return Boolean(target.propertyId) && authorize(context, "view", resource, at) &&
    propertyFinanceAuthorityChecks(resource).every(check =>
      (check.organizationOnly ? authorizeOrganizationSource : authorize)(context, check.action, check.resource, at)) &&
    authorizeUnconditionalSource(context, "view", { ...resource, type: "reservation", dataClass: "operational" }, at);

  const source = report.kind === "TEAM" ? teamReportSources : report.kind === "COMPANY" ? companyReportSources
    : report.kind === "INVENTORY" ? inventoryReportSources : kpiReportSources;
  return authorizeUnconditionalSource(context, "view", resource, at, !target.propertyId) &&
    [...source.operationalSources, ...source.financialSources].every(type =>
      authorizeOrganizationSource(context, "view", { type, organizationId: target.organizationId }, at));
}

export function scheduledReportHref(target: ScheduledReportTarget, locale: string) {
  const { reportRun, propertyId } = target;
  const paths = { COMPANY: "company", TEAM: "team", INVENTORY: "inventory", KPI: "kpis" };
  const filters = reportRun.kind === "KPI" ? kpiDimensionSchema.parse(reportRun.filters) : {};
  const params = new URLSearchParams({ fromOn: reportRun.fromOn, toOn: reportRun.toOn, currency: reportRun.currency });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (reportRun.kind !== "PROPERTY" && propertyId) params.set("propertyId", propertyId);
  const path = reportRun.kind === "PROPERTY" ? "/app/properties/" + propertyId + "/reports" : "/app/reports/" + paths[reportRun.kind];
  return "/" + locale + path + "?" + params.toString();
}
