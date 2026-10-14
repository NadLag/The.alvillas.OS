"use server";

import { revalidatePath } from "next/cache";
import {
  archiveCity,
  archiveRegion,
  createCity,
  createRegion,
  GeographyAuthorizationError,
  GeographyConflictError,
  GeographyNotFoundError,
  parseCityInput,
  parseRegionInput
} from "@/modules/organization/application/geography-service";
import { organizationActorContextFromSession } from "@/modules/organization/application/organization-access";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";

export type GeographyFormState = {
  status: "idle" | "success" | "error";
  messageKey?:
    | "saved"
    | "archived"
    | "validation"
    | "unauthorized"
    | "forbidden"
    | "notFound"
    | "conflict"
    | "generic";
  fieldErrors?: Record<string, string[]>;
};

function formValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);

  return typeof value === "string" ? value : undefined;
}

async function geographyContext() {
  const session = await auth();
  const ctx = await organizationActorContextFromSession(session);

  if (!ctx) {
    return null;
  }

  return ctx;
}

function errorState(error: unknown): GeographyFormState {
  if (error instanceof GeographyAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof GeographyNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof GeographyConflictError) {
    return { status: "error", messageKey: "conflict" };
  }

  return { status: "error", messageKey: "generic" };
}

export async function createRegionAction(
  locale: string,
  _state: GeographyFormState,
  formData: FormData
): Promise<GeographyFormState> {
  const ctx = await geographyContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseRegionInput({
    name: formValue(formData, "name"),
    code: formValue(formData, "code"),
    description: formValue(formData, "description"),
    sortOrder: formValue(formData, "sortOrder")
  });

  if (!parsed.success) {
    return {
      status: "error",
      messageKey: "validation",
      fieldErrors: parsed.error.flatten().fieldErrors
    };
  }

  try {
    await createRegion(ctx, parsed.data);
    revalidatePath(`/${safeLocale(locale)}/app/organization/geography`);

    return { status: "success", messageKey: "saved" };
  } catch (error) {
    return errorState(error);
  }
}

export async function createCityAction(
  locale: string,
  _state: GeographyFormState,
  formData: FormData
): Promise<GeographyFormState> {
  const ctx = await geographyContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseCityInput({
    regionId: formValue(formData, "regionId"),
    name: formValue(formData, "name"),
    countryCode: formValue(formData, "countryCode"),
    timezone: formValue(formData, "timezone"),
    sortOrder: formValue(formData, "sortOrder")
  });

  if (!parsed.success) {
    return {
      status: "error",
      messageKey: "validation",
      fieldErrors: parsed.error.flatten().fieldErrors
    };
  }

  try {
    await createCity(ctx, parsed.data);
    revalidatePath(`/${safeLocale(locale)}/app/organization/geography`);

    return { status: "success", messageKey: "saved" };
  } catch (error) {
    return errorState(error);
  }
}

export async function archiveRegionAction(
  locale: string,
  _state: GeographyFormState,
  formData: FormData
): Promise<GeographyFormState> {
  const ctx = await geographyContext();
  const regionId = formValue(formData, "regionId");

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  if (!regionId) {
    return { status: "error", messageKey: "validation" };
  }

  try {
    await archiveRegion(ctx, regionId);
    revalidatePath(`/${safeLocale(locale)}/app/organization/geography`);

    return { status: "success", messageKey: "archived" };
  } catch (error) {
    return errorState(error);
  }
}

export async function archiveCityAction(
  locale: string,
  _state: GeographyFormState,
  formData: FormData
): Promise<GeographyFormState> {
  const ctx = await geographyContext();
  const cityId = formValue(formData, "cityId");

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  if (!cityId) {
    return { status: "error", messageKey: "validation" };
  }

  try {
    await archiveCity(ctx, cityId);
    revalidatePath(`/${safeLocale(locale)}/app/organization/geography`);

    return { status: "success", messageKey: "archived" };
  } catch (error) {
    return errorState(error);
  }
}
