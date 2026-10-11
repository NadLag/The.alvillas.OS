"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import {
  AirbnbSettlementAuthorizationError,
  AirbnbSettlementConfigError,
  AirbnbSettlementConflictError,
  AirbnbSettlementNotFoundError,
  importAirbnbSettlementCsv,
  parseAirbnbSettlementImportInput
} from "@/modules/finance/application/airbnb-settlement-service";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { AirbnbSettlementCsvError } from "@/modules/finance/domain/airbnb-settlement";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type AirbnbSettlementFormState = {
  status: "idle" | "error";
  messageKey?:
    | "validation"
    | "unauthorized"
    | "forbidden"
    | "notFound"
    | "config"
    | "conflict"
    | "generic";
  fieldErrors?: Record<string, string[]>;
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function flattenZodError(error: ZodError): AirbnbSettlementFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): AirbnbSettlementFormState {
  if (error instanceof AirbnbSettlementAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof AirbnbSettlementNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof AirbnbSettlementConfigError) {
    return { status: "error", messageKey: "config" };
  }

  if (error instanceof AirbnbSettlementConflictError) {
    return { status: "error", messageKey: "conflict" };
  }

  if (error instanceof AirbnbSettlementCsvError) {
    return {
      status: "error",
      messageKey: "validation",
      fieldErrors: {
        csv: [error.message]
      }
    };
  }

  return { status: "error", messageKey: "generic" };
}

export async function importAirbnbSettlementAction(
  locale: string,
  _state: AirbnbSettlementFormState,
  formData: FormData
): Promise<AirbnbSettlementFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = financeActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseAirbnbSettlementImportInput({
    csv: formValue(formData, "csv"),
    receivedAccountId: formValue(formData, "receivedAccountId"),
    idempotencyKey: formValue(formData, "idempotencyKey")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await importAirbnbSettlementCsv(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/reservations`);
  revalidatePath(`/${appLocale}/app/owner-portal`);
  redirect(`/${appLocale}/app/reservations`);
}
