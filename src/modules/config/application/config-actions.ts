"use server";

import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";
import { configActorContextFromSession } from "@/modules/config/application/config-access";
import {
  ConfigAuthorizationError,
  ConfigNotFoundError,
  ConfigValidationError,
  activateConfigRuleVersion,
  createConfigRuleVersion,
  parseConfigLifecycleActionInput,
  parseConfigRuleInput,
  retireConfigRuleVersion
} from "@/modules/config/application/config-service";

export type ConfigFormState = {
  status: "idle" | "error" | "success";
  messageKey?:
    | "created"
    | "activated"
    | "retired"
    | "validation"
    | "unauthorized"
    | "forbidden"
    | "notFound"
    | "generic";
  fieldErrors?: Record<string, string[]>;
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function flattenZodError(error: ZodError): ConfigFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): ConfigFormState {
  if (error instanceof ConfigAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof ConfigNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof ConfigValidationError) {
    return { status: "error", messageKey: "validation" };
  }

  return { status: "error", messageKey: "generic" };
}

export async function createConfigRuleAction(
  _locale: string,
  _state: ConfigFormState,
  formData: FormData
): Promise<ConfigFormState> {
  const session = await auth();
  const ctx = await configActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseConfigRuleInput({
    key: formValue(formData, "key"),
    customFeatureFlagKey: formValue(formData, "customFeatureFlagKey"),
    scopeType: formValue(formData, "scopeType"),
    scopeId: formValue(formData, "scopeId"),
    lifecycle: formValue(formData, "lifecycle"),
    valueJson: formValue(formData, "valueJson"),
    effectiveFrom: formValue(formData, "effectiveFrom"),
    effectiveTo: formValue(formData, "effectiveTo") || undefined,
    reason: formValue(formData, "reason")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await createConfigRuleVersion(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  // The dynamic configuration page refreshes after the success state commits.
  // Bundling its entire property roster here would delay confirmation of a saved rule.
  return { status: "success", messageKey: "created" };
}

export async function activateConfigRuleAction(
  locale: string,
  _state: ConfigFormState,
  formData: FormData
): Promise<ConfigFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await configActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseConfigLifecycleActionInput({
    ruleId: formValue(formData, "ruleId"),
    effectiveFrom: formValue(formData, "effectiveFrom"),
    reason: formValue(formData, "reason")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await activateConfigRuleVersion(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/configuration`);
  return { status: "success", messageKey: "activated" };
}

export async function retireConfigRuleAction(
  locale: string,
  _state: ConfigFormState,
  formData: FormData
): Promise<ConfigFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await configActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseConfigLifecycleActionInput({
    ruleId: formValue(formData, "ruleId"),
    effectiveFrom: formValue(formData, "effectiveFrom"),
    reason: formValue(formData, "reason")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await retireConfigRuleVersion(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/configuration`);
  return { status: "success", messageKey: "retired" };
}
