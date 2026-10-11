import { z } from "zod";

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );
const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase())
    .optional()
);

export const reservationSourceSchema = z.enum([
  "MANUAL",
  "DIRECT",
  "AGENCY",
  "AIRBNB",
  "BOOKING",
  "VRBO"
]);

export const taskTypeSchema = z.enum([
  "ARRIVAL_PREPARATION",
  "CHECKOUT_CLEANING",
  "CLEANING_MIDSTAY",
  "INSPECTION",
  "POOL",
  "GARDEN",
  "MAINTENANCE",
  "CUSTOM"
]);

export const taskDueAnchorSchema = z.enum(["CHECK_IN", "CHECK_OUT"]);

export const taskChecklistTemplateSchema = z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.-]+$/u),
  label: z.object({
    en: requiredText(120),
    fr: requiredText(120),
    ar: optionalText(120)
  })
});

export const reservationTaskTemplateSchema = z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.-]+$/u),
  type: taskTypeSchema,
  title: z.object({
    en: requiredText(120),
    fr: requiredText(120),
    ar: optionalText(120)
  }),
  due: taskDueAnchorSchema,
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  checklist: z.array(taskChecklistTemplateSchema).max(24).default([])
});

export const reservationTaskConfigSchema = z.object({
  tasks: z.array(reservationTaskTemplateSchema).min(1).max(12)
});

export type ReservationTaskTemplate = z.infer<typeof reservationTaskTemplateSchema>;
export type ReservationTaskConfig = z.infer<typeof reservationTaskConfigSchema>;

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD");

export const manualReservationInputSchema = z
  .object({
    propertyId: z.string().uuid(),
    guestName: requiredText(160),
    guestEmail: optionalEmail,
    source: reservationSourceSchema.default("MANUAL"),
    externalId: optionalText(160),
    checkIn: dateStringSchema,
    checkOut: dateStringSchema,
    adultCount: z.coerce.number().int().min(0).default(1),
    childCount: z.coerce.number().int().min(0).default(0),
    notes: optionalText(1000),
    idempotencyKey: z.string().uuid()
  })
  .superRefine((input, ctx) => {
    if (dateToUtc(input.checkOut).getTime() <= dateToUtc(input.checkIn).getTime()) {
      ctx.addIssue({
        code: "custom",
        path: ["checkOut"],
        message: "Check-out must be after check-in"
      });
    }
  });

export type ManualReservationInput = z.infer<typeof manualReservationInputSchema>;

export type ReservationSummary = {
  id: string;
  reference: string;
  propertyId: string;
  propertyName: string;
  guestName: string;
  source: z.infer<typeof reservationSourceSchema>;
  status: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  conflictCount: number;
  createdAt: Date;
};

export type OperationTaskSummary = {
  id: string;
  propertyId: string;
  propertyName: string;
  reservationReference: string | null;
  guestName: string | null;
  type: z.infer<typeof taskTypeSchema>;
  state: string;
  priority: string;
  dueDate: Date;
  title: Record<string, string>;
  assignedToUserAccountId: string | null;
  completedByUserAccountId: string | null;
  completionIdempotencyKey: string | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type OperationTaskChecklistItemSummary = {
  id: string;
  key: string;
  label: Record<string, string>;
  completedAt: Date | null;
};

export type FieldTaskSummary = OperationTaskSummary & {
  checklistItems: OperationTaskChecklistItemSummary[];
};

export type ManualReservationResult = {
  reservation: ReservationSummary;
  tasks: OperationTaskSummary[];
  conflictCount: number;
  idempotent: boolean;
};

export function dateToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const milliseconds = dateToUtc(checkOut).getTime() - dateToUtc(checkIn).getTime();
  return Math.round(milliseconds / 86_400_000);
}

export function localizedTaskTitle(
  title: Record<string, string>,
  locale: string
): string {
  return title[locale] ?? title.en ?? Object.values(title)[0] ?? "";
}

export function localizedChecklistLabel(
  label: Record<string, string>,
  locale: string
): string {
  return label[locale] ?? label.en ?? Object.values(label)[0] ?? "";
}

export const completeTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  checklistItemIds: z.array(z.string().uuid()).min(1).max(50),
  note: optionalText(1000)
});

export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;
