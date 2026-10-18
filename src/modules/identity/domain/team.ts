import { z } from "zod";
import Decimal from "decimal.js";
import { Money } from "@/platform/money/money";
import { personProfileInputSchema, updatePersonProfileInputSchema } from "./identity";

export const teamOperations = z.enum([
  "profile",
  "assignment",
  "retire",
  "compensation",
  "availability",
  "decision",
  "wallet",
  "offboard",
  "document",
  "archive_document"
]);
export type TeamOperation = z.infer<typeof teamOperations>;
export function parseTeamForm(operation: TeamOperation, data: FormData) {
  const text = (key: string) => {
    const value = data.get(key);
    return typeof value === "string" ? value : "";
  };
  const reason = text("reason");
  const personId = text("personId");
  switch (operation) {
    case "profile": {
      const profile = {
        displayName: text("displayName"),
        email: text("email"),
        phone: text("phone"),
        preferredLocale: text("preferredLocale")
      };
      return personId
        ? updatePersonProfileInputSchema.parse({ ...profile, personId })
        : personProfileInputSchema.parse(profile);
    }
    case "assignment":
      return teamAssignmentSchema.parse({
        personId,
        roleId: text("roleId"),
        userAccountId: text("userAccountId") || null,
        scopeType: text("scopeType"),
        scopeId: text("scopeId") || null,
        validFrom: text("validFrom"),
        validTo: text("validTo") || null,
        assignedToMe: data.has("assignedToMe"),
        reason
      });
    case "compensation":
      return compensationSchema.parse({
        assignmentId: text("assignmentId"),
        expectedVersion: Number(text("expectedVersion")),
        mode: text("mode"),
        amount: text("amount"),
        currency: text("currency"),
        effectiveFrom: text("effectiveFrom"),
        reason
      });
    case "availability":
      return availabilitySchema.parse({
        personId,
        kind: text("kind"),
        startsOn: text("startsOn"),
        endsOn: text("endsOn"),
        reason
      });
    case "decision":
      return availabilityDecisionSchema.parse({ id: text("id"), decision: text("decision"), reason });
    case "document": {
      const file = data.get("file") as File | null;
      return documentSchema.parse({
        personId,
        title: text("title"),
        kind: text("kind"),
        expiresOn: text("expiresOn") || null,
        contentType: file?.type,
        size: file?.size,
        reason
      });
    }
    case "wallet":
      return walletLinkSchema.parse({
        personId,
        ledgerAccountId: text("ledgerAccountId") || null,
        accountName: text("accountName") || undefined,
        reason
      });
    case "offboard":
      return z
        .object({ personId: z.string().uuid(), reason: z.string().trim().min(6).max(500) })
        .strict()
        .parse({ personId, reason });
    default:
      return z
        .object({ id: z.string().uuid(), reason: z.string().trim().min(6).max(500) })
        .strict()
        .parse({ id: text("id"), reason });
  }
}

export const teamPageSchema = z.object({
  search: z.string().trim().max(120).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1)
});
const instantSchema = z.union([
  z.date(),
  z
    .string()
    .refine(
      (value) =>
        /^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(value) &&
        dateOnly.safeParse(value.slice(0, 10)).success &&
        Number.isFinite(new Date(value).getTime())
    )
    .transform((value) => new Date(value))
]);
export const walletLinkSchema = z
  .object({
    personId: z.string().uuid(),
    ledgerAccountId: z.string().uuid().nullable().optional(),
    accountName: z.string().trim().min(2).max(120).optional(),
    reason: z.string().trim().min(6).max(500)
  })
  .strict()
  .refine((v) => v.ledgerAccountId || v.accountName);
export const teamAssignmentSchema = z
  .object({
    personId: z.string().uuid(),
    roleId: z.string().uuid(),
    userAccountId: z.string().uuid().nullable().optional(),
    scopeType: z.enum(["organization", "region", "city", "property", "job"]),
    scopeId: z.string().uuid().nullable(),
    validFrom: instantSchema,
    validTo: instantSchema.nullable(),
    assignedToMe: z.boolean(),
    reason: z.string().trim().min(6).max(500)
  })
  .strict()
  .refine((v) => (v.scopeType === "organization" ? v.scopeId === null : v.scopeId !== null))
  .refine((v) => !v.validTo || v.validTo > v.validFrom);
export const compensationSchema = z
  .object({
    assignmentId: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
    mode: z.enum(["PER_JOB", "PER_MONTH", "PER_HOUR", "PERCENTAGE"]),
    amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    effectiveFrom: instantSchema,
    reason: z.string().trim().min(6).max(500)
  })
  .strict()
  .refine((v) => v.mode !== "PERCENTAGE" || new Decimal(v.amount).lte(100));
export type CompensationInput = z.infer<typeof compensationSchema>;
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const availabilitySchema = z
  .object({
    personId: z.string().uuid(),
    kind: z.enum(["AVAILABLE", "UNAVAILABLE", "LEAVE"]),
    startsOn: dateOnly,
    endsOn: dateOnly,
    reason: z.string().trim().min(6).max(500)
  })
  .strict()
  .refine((v) => v.endsOn > v.startsOn);
export const availabilityDecisionSchema = z
  .object({
    id: z.string().uuid(),
    decision: z.enum(["APPROVED", "REJECTED", "CANCELLED"]),
    reason: z.string().trim().min(6).max(500)
  })
  .strict();
export const documentSchema = z
  .object({
    personId: z.string().uuid(),
    title: z.string().trim().min(2).max(120),
    kind: z.enum(["CONTRACT", "IDENTITY", "OTHER"]),
    expiresOn: dateOnly.nullable(),
    contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    size: z.number().int().positive().max(4000000),
    reason: z.string().trim().min(6).max(500)
  })
  .strict();
export const teamPolicyKey = "staff.management_policy";
export const teamPolicySchema = z
  .object({
    document_max_bytes: z.number().int().min(1024).max(4000000),
    document_reminder_days: z.array(z.number().int().min(0).max(365)).min(1).max(10),
    document_link_seconds: z.number().int().min(30).max(900)
  })
  .strict();
export function intervalsOverlap(
  a: { startsOn: string; endsOn: string },
  b: { startsOn: string; endsOn: string }
) {
  return a.startsOn < b.endsOn && b.startsOn < a.endsOn;
}
export function compensationValue(input: Pick<CompensationInput, "amount" | "currency">) {
  return Money.of(input.amount, input.currency).toJSON();
}
export function performance(
  tasks: readonly {
    state: string;
    dueDate: Date;
    completedAt: Date | null;
    today?: string;
    property?: { timezone: string };
  }[],
  today: string
) {
  const done = tasks.filter((t) => t.state === "COMPLETED");
  const eligible = tasks.filter((t) => t.state !== "CANCELLED").length;
  return {
    assigned: tasks.length,
    completed: done.length,
    onTime: done.filter(
      (t) =>
        t.completedAt &&
        new Intl.DateTimeFormat("en-CA", {
          timeZone: t.property?.timezone ?? "Africa/Casablanca",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(t.completedAt) <= t.dueDate.toISOString().slice(0, 10)
    ).length,
    completionRate: eligible ? new Decimal(done.length).div(eligible).mul(100).toFixed(1) : "0.0",
    open: tasks.filter((t) => !["COMPLETED", "CANCELLED"].includes(t.state)).length,
    overdue: tasks.filter(
      (t) =>
        !["COMPLETED", "CANCELLED"].includes(t.state) &&
        t.dueDate.toISOString().slice(0, 10) < (t.today ?? today)
    ).length
  };
}
