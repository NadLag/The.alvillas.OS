"use client";

import { useActionState, useMemo } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import { appLocales, compactLocaleLabels } from "@/i18n/routing";
import {
  updateOrganizationSettingsAction,
  type OrganizationFormState
} from "@/modules/organization/application/organization-actions";
import type { OrganizationSettingsSummary } from "@/modules/organization/domain/organization-settings";

type FormLabels = {
  name: string;
  legalName: string;
  brandName: string;
  baseCurrency: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  websiteUrl: string;
  supportEmail: string;
  supportPhone: string;
  defaultLocale: string;
  timezone: string;
  countryCode: string;
  fiscalYearStartMonth: string;
  save: string;
  saving: string;
  saved: string;
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  currencyLocked: string;
  generic: string;
};

type OrganizationSettingsFormProps = {
  locale: string;
  labels: FormLabels;
  settings: OrganizationSettingsSummary;
};

const initialState: OrganizationFormState = { status: "idle" };

function messageForState(state: OrganizationFormState, labels: FormLabels): string | null {
  switch (state.messageKey) {
    case "saved":
      return labels.saved;
    case "validation":
      return labels.validation;
    case "unauthorized":
      return labels.unauthorized;
    case "forbidden":
      return labels.forbidden;
    case "notFound":
      return labels.notFound;
    case "currencyLocked":
      return labels.currencyLocked;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function fieldError(state: OrganizationFormState, field: string): string | null {
  return state.fieldErrors?.[field]?.[0] ?? null;
}

function ErrorText({ children, testId }: { children: string | null; testId: string }) {
  if (!children) {
    return null;
  }

  return (
    <p className="field-error" data-testid={testId}>
      {children}
    </p>
  );
}

function firstClientError(error: unknown): string | null {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : null;
}

export function OrganizationSettingsForm({ locale, labels, settings }: OrganizationSettingsFormProps) {
  const schema = useMemo(
    () =>
      z.object({
        accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u, labels.validation),
        baseCurrency: z.string().trim().length(3, labels.validation),
        brandName: z.string().trim().min(1, labels.validation),
        countryCode: z.string().trim().length(2, labels.validation),
        defaultLocale: z.enum(appLocales),
        fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
        legalName: z.string().optional(),
        logoUrl: z
          .string()
          .url(labels.validation)
          .refine((value) => value.startsWith("https://"), labels.validation)
          .or(z.literal("")),
        name: z.string().trim().min(1, labels.validation),
        primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u, labels.validation),
        supportEmail: z.string().trim().email(labels.validation).or(z.literal("")),
        supportPhone: z.string().optional(),
        timezone: z.string().trim().min(1, labels.validation),
        websiteUrl: z
          .string()
          .url(labels.validation)
          .refine((value) => value.startsWith("https://"), labels.validation)
          .or(z.literal(""))
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      accentColor: settings.accentColor,
      baseCurrency: settings.baseCurrency,
      brandName: settings.brandName,
      countryCode: settings.countryCode,
      defaultLocale: settings.defaultLocale,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      legalName: settings.legalName ?? "",
      logoUrl: settings.logoUrl ?? "",
      name: settings.name,
      primaryColor: settings.primaryColor,
      supportEmail: settings.supportEmail ?? "",
      supportPhone: settings.supportPhone ?? "",
      timezone: settings.timezone,
      websiteUrl: settings.websiteUrl ?? ""
    }
  });
  const [state, formAction, pending] = useActionState(
    updateOrganizationSettingsAction.bind(null, locale),
    initialState
  );
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);

  return (
    <form
      action={formAction}
      className="resource-form"
      data-testid="organization-settings-form"
      onSubmit={validateSubmit}
    >
      <div className="form-grid two">
        <label className="field">
          <span>{labels.name}</span>
          <input data-testid="organization-name" required {...form.register("name")} />
          <ErrorText testId="organization-name-error">
            {firstClientError(form.formState.errors.name) ?? fieldError(state, "name")}
          </ErrorText>
        </label>
        <label className="field">
          <span>{labels.brandName}</span>
          <input data-testid="organization-brand-name" required {...form.register("brandName")} />
          <ErrorText testId="organization-brand-name-error">
            {firstClientError(form.formState.errors.brandName) ?? fieldError(state, "brandName")}
          </ErrorText>
        </label>
      </div>
      <label className="field">
        <span>{labels.legalName}</span>
        <input data-testid="organization-legal-name" {...form.register("legalName")} />
      </label>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.baseCurrency}</span>
          <input
            data-testid="organization-base-currency"
            maxLength={3}
            readOnly={settings.baseCurrencyLocked}
            {...form.register("baseCurrency")}
          />
          <ErrorText testId="organization-base-currency-error">
            {firstClientError(form.formState.errors.baseCurrency) ?? fieldError(state, "baseCurrency")}
          </ErrorText>
        </label>
        <label className="field">
          <span>{labels.defaultLocale}</span>
          <select data-testid="organization-default-locale" {...form.register("defaultLocale")}>
            {appLocales.map((appLocale) => (
              <option key={appLocale} value={appLocale}>
                {compactLocaleLabels[appLocale]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.countryCode}</span>
          <input data-testid="organization-country-code" maxLength={2} {...form.register("countryCode")} />
          <ErrorText testId="organization-country-code-error">
            {firstClientError(form.formState.errors.countryCode) ?? fieldError(state, "countryCode")}
          </ErrorText>
        </label>
      </div>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.timezone}</span>
          <input data-testid="organization-timezone" required {...form.register("timezone")} />
        </label>
        <label className="field">
          <span>{labels.fiscalYearStartMonth}</span>
          <input
            data-testid="organization-fiscal-month"
            max={12}
            min={1}
            type="number"
            {...form.register("fiscalYearStartMonth")}
          />
        </label>
        <label className="field">
          <span>{labels.supportPhone}</span>
          <input data-testid="organization-support-phone" {...form.register("supportPhone")} />
        </label>
      </div>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.supportEmail}</span>
          <input data-testid="organization-support-email" type="email" {...form.register("supportEmail")} />
        </label>
        <label className="field">
          <span>{labels.websiteUrl}</span>
          <input data-testid="organization-website-url" type="url" {...form.register("websiteUrl")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.logoUrl}</span>
        <input data-testid="organization-logo-url" type="url" {...form.register("logoUrl")} />
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.primaryColor}</span>
          <input data-testid="organization-primary-color" type="color" {...form.register("primaryColor")} />
        </label>
        <label className="field">
          <span>{labels.accentColor}</span>
          <input data-testid="organization-accent-color" type="color" {...form.register("accentColor")} />
        </label>
      </div>
      {message ? (
        <p
          className={state.status === "success" ? "form-status" : "form-error"}
          data-testid="organization-form-message"
          role={state.status === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="organization-submit" disabled={pending} type="submit">
        {pending ? labels.saving : labels.save}
      </button>
    </form>
  );
}
