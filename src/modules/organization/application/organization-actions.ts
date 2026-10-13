"use server";

import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  organizationActorContextFromSession,
  OrganizationAuthorizationError
} from "@/modules/organization/application/organization-access";
import {
  OrganizationCurrencyLockedError,
  OrganizationNotFoundError,
  parseOrganizationSettingsInput,
  updateOrganizationSettings
} from "@/modules/organization/application/organization-service";

export type OrganizationFormState = {
  status: "idle" | "success" | "error";
  messageKey?: "saved" | "validation" | "unauthorized" | "forbidden" | "notFound" | "currencyLocked" | "generic";
  fieldErrors?: Record<string, string[]>;
};

function formValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);

  return typeof value === "string" ? value : undefined;
}

function flattenZodError(error: ZodError): OrganizationFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export async function updateOrganizationSettingsAction(
  locale: string,
  _state: OrganizationFormState,
  formData: FormData
): Promise<OrganizationFormState> {
  const appLocale = safeLocale(locale);
  const parsed = parseOrganizationSettingsInput({
    name: formValue(formData, "name"),
    legalName: formValue(formData, "legalName"),
    brandName: formValue(formData, "brandName"),
    baseCurrency: formValue(formData, "baseCurrency"),
    logoUrl: formValue(formData, "logoUrl"),
    primaryColor: formValue(formData, "primaryColor"),
    accentColor: formValue(formData, "accentColor"),
    websiteUrl: formValue(formData, "websiteUrl"),
    supportEmail: formValue(formData, "supportEmail"),
    supportPhone: formValue(formData, "supportPhone"),
    defaultLocale: formValue(formData, "defaultLocale"),
    timezone: formValue(formData, "timezone"),
    countryCode: formValue(formData, "countryCode"),
    fiscalYearStartMonth: formValue(formData, "fiscalYearStartMonth")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  const ctx = await organizationActorContextFromSession(await auth());

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  try {
    await updateOrganizationSettings(ctx, parsed.data);
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError) {
      return { status: "error", messageKey: "forbidden" };
    }

    if (error instanceof OrganizationNotFoundError) {
      return { status: "error", messageKey: "notFound" };
    }

    if (error instanceof OrganizationCurrencyLockedError) {
      return { status: "error", messageKey: "currencyLocked" };
    }

    return { status: "error", messageKey: "generic" };
  }

  revalidatePath(`/${appLocale}/app/organization`);

  return { status: "success", messageKey: "saved" };
}
