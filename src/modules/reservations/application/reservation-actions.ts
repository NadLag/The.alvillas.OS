"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  ReservationAuthorizationError,
  ReservationConfigError,
  ReservationConflictError,
  ReservationNotFoundError,
  completeAssignedFieldTask,
  createManualReservation,
  parseCompleteTaskInput,
  parseManualReservationInput
} from "@/modules/reservations/application/reservation-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type ReservationFormState = {
  status: "idle" | "error";
  messageKey?: "validation" | "unauthorized" | "forbidden" | "notFound" | "config" | "conflict" | "generic";
  fieldErrors?: Record<string, string[]>;
};

export type FieldTaskFormState = {
  status: "idle" | "error";
  messageKey?: "validation" | "unauthorized" | "forbidden" | "notFound" | "config" | "conflict" | "generic";
  fieldErrors?: Record<string, string[]>;
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function flattenZodError(error: ZodError): ReservationFormState | FieldTaskFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): ReservationFormState | FieldTaskFormState {
  if (error instanceof ReservationAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof ReservationNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof ReservationConfigError) {
    return { status: "error", messageKey: "config" };
  }

  if (error instanceof ReservationConflictError) {
    return { status: "error", messageKey: "conflict" };
  }

  return { status: "error", messageKey: "generic" };
}

export async function createManualReservationAction(
  locale: string,
  _state: ReservationFormState,
  formData: FormData
): Promise<ReservationFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseManualReservationInput({
    propertyId: formValue(formData, "propertyId"),
    guestName: formValue(formData, "guestName"),
    guestEmail: formValue(formData, "guestEmail"),
    guestPhone: formValue(formData, "guestPhone"),
    guestPreferredLocale: formValue(formData, "guestPreferredLocale"),
    source: formValue(formData, "source") ?? "MANUAL",
    externalId: formValue(formData, "externalId"),
    checkIn: formValue(formData, "checkIn"),
    checkOut: formValue(formData, "checkOut"),
    adultCount: formValue(formData, "adultCount") ?? "1",
    childCount: formValue(formData, "childCount") ?? "0",
    notes: formValue(formData, "notes"),
    ...(formData.get("amount") ? { quote: { amount: formData.get("amount"), currency: formData.get("currency") } } : {}),
    idempotencyKey: formValue(formData, "idempotencyKey")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await createManualReservation(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/reservations`);
  revalidatePath(`/${appLocale}/app/operations`);
  redirect(`/${appLocale}/app/operations?propertyId=${parsed.data.propertyId}`);
}

export async function completeFieldTaskAction(
  locale: string,
  _state: FieldTaskFormState,
  formData: FormData
): Promise<FieldTaskFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseCompleteTaskInput({
    taskId: formValue(formData, "taskId"),
    idempotencyKey: formValue(formData, "idempotencyKey"),
    checklistItemIds: formData.getAll("checklistItemIds"),
    note: formValue(formData, "note")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await completeAssignedFieldTask(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/field`);
  revalidatePath(`/${appLocale}/app/field/${parsed.data.taskId}`);
  redirect(`/${appLocale}/app/field`);
}
