import { z } from "zod";

const emptyString = z.literal("").transform(() => undefined);
const optionalTrimmed = z
  .string()
  .trim()
  .max(160)
  .optional()
  .or(emptyString);

const optionalDate = z
  .union([z.date(), z.string().trim().or(emptyString)])
  .optional()
  .transform((value, ctx) => {
    if (!value) {
      return undefined;
    }

    if (value instanceof Date) {
      return value;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid date"
      });
      return z.NEVER;
    }

    return date;
  });

export const auditLogFilterSchema = z
  .object({
    action: optionalTrimmed,
    resourceType: optionalTrimmed,
    actorId: optionalTrimmed,
    requestId: optionalTrimmed,
    from: optionalDate,
    to: optionalDate,
    limit: z.coerce.number().int().min(1).max(200).default(50)
  })
  .refine((value) => !value.from || !value.to || value.to.getTime() >= value.from.getTime(), {
    path: ["to"],
    message: "To date must be after from date"
  });

export type AuditLogFilterInput = {
  action?: string;
  resourceType?: string;
  actorId?: string;
  requestId?: string;
  from?: Date;
  to?: Date;
  limit: number;
};

export function parseAuditLogFilters(input: unknown) {
  return auditLogFilterSchema.safeParse(input);
}

