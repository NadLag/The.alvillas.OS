"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import {
  ReservationRevenueAuthorizationError,
  ReservationRevenueConfigError,
  ReservationRevenueConflictError,
  ReservationRevenueNotFoundError,
  parseReservationRevenueInput,
  recordReservationAccommodationRevenue
} from "@/modules/finance/application/reservation-revenue-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type ReservationRevenueFormState = {
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

function flattenZodError(error: ZodError): ReservationRevenueFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): ReservationRevenueFormState {
  if (error instanceof ReservationRevenueAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof ReservationRevenueNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof ReservationRevenueConfigError) {
    return { status: "error", messageKey: "config" };
  }

  if (error instanceof ReservationRevenueConflictError) {
    return { status: "error", messageKey: "conflict" };
  }

  return { status: "error", messageKey: "generic" };
}

export async function recordReservationRevenueAction(
  locale: string,
  _state: ReservationRevenueFormState,
  formData: FormData
): Promise<ReservationRevenueFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await financeActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseReservationRevenueInput({
    reservationId: formValue(formData, "reservationId"),
    amount: formValue(formData, "amount"),
    currency: formValue(formData, "currency") ?? "MAD",
    receivedAccountId: formValue(formData, "receivedAccountId"),
    idempotencyKey: formValue(formData, "idempotencyKey")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  let result: Awaited<ReturnType<typeof recordReservationAccommodationRevenue>>;
  try {
    result = await recordReservationAccommodationRevenue(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/reservations`);
  revalidatePath(`/${appLocale}/app/owner-portal`);
  revalidatePath(`/${appLocale}/app/owner-portal/properties/${result.propertyId}`);
  redirect(`/${appLocale}/app/reservations`);
}
