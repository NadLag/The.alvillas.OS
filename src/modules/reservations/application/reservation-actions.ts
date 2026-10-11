"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  ReservationAuthorizationError,
  ReservationConfigError,
  ReservationNotFoundError,
  createManualReservation,
  parseManualReservationInput
} from "@/modules/reservations/application/reservation-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type ReservationFormState = {
  status: "idle" | "error";
  messageKey?: "validation" | "unauthorized" | "forbidden" | "notFound" | "config" | "generic";
  fieldErrors?: Record<string, string[]>;
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function flattenZodError(error: ZodError): ReservationFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): ReservationFormState {
  if (error instanceof ReservationAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof ReservationNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof ReservationConfigError) {
    return { status: "error", messageKey: "config" };
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
  const ctx = reservationActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseManualReservationInput({
    propertyId: formValue(formData, "propertyId"),
    guestName: formValue(formData, "guestName"),
    guestEmail: formValue(formData, "guestEmail"),
    source: formValue(formData, "source") ?? "MANUAL",
    checkIn: formValue(formData, "checkIn"),
    checkOut: formValue(formData, "checkOut"),
    adultCount: formValue(formData, "adultCount") ?? "1",
    childCount: formValue(formData, "childCount") ?? "0",
    notes: formValue(formData, "notes"),
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
  redirect(`/${appLocale}/app/operations`);
}
