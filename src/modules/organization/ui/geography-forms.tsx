"use client";

import { useActionState, useMemo } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import {
  archiveCityAction,
  archiveRegionAction,
  createCityAction,
  createRegionAction,
  type GeographyFormState
} from "@/modules/organization/application/geography-actions";
import type { CitySummary, RegionSummary } from "@/modules/organization/domain/geography";

type GeographyLabels = {
  regionName: string;
  regionCode: string;
  regionDescription: string;
  cityName: string;
  cityRegion: string;
  cityCountry: string;
  cityTimezone: string;
  sortOrder: string;
  saveRegion: string;
  saveCity: string;
  archive: string;
  saving: string;
  saved: string;
  archived: string;
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  conflict: string;
  generic: string;
  noRegion: string;
};

const initialState: GeographyFormState = { status: "idle" };

function messageForState(state: GeographyFormState, labels: GeographyLabels): string | null {
  switch (state.messageKey) {
    case "saved":
      return labels.saved;
    case "archived":
      return labels.archived;
    case "validation":
      return labels.validation;
    case "unauthorized":
      return labels.unauthorized;
    case "forbidden":
      return labels.forbidden;
    case "notFound":
      return labels.notFound;
    case "conflict":
      return labels.conflict;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function fieldError(state: GeographyFormState, field: string): string | null {
  return state.fieldErrors?.[field]?.[0] ?? null;
}

function firstClientError(error: unknown): string | null {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : null;
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

function FormMessage({ labels, state, testId }: { labels: GeographyLabels; state: GeographyFormState; testId: string }) {
  const message = messageForState(state, labels);

  if (!message) {
    return null;
  }

  return (
    <p
      className={state.status === "success" ? "form-status" : "form-error"}
      data-testid={testId}
      role={state.status === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

export function RegionCreateForm({ labels, locale }: { labels: GeographyLabels; locale: string }) {
  const schema = useMemo(
    () =>
      z.object({
        code: z.string().optional(),
        description: z.string().optional(),
        name: z.string().trim().min(1, labels.validation),
        sortOrder: z.coerce.number().min(0, labels.validation)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      code: "",
      description: "",
      name: "",
      sortOrder: 0
    }
  });
  const [state, formAction, pending] = useActionState(
    createRegionAction.bind(null, locale),
    initialState
  );
  const validateSubmit = useServerActionValidation(form, formAction);

  return (
    <form className="resource-form" action={formAction} data-testid="region-create-form" onSubmit={validateSubmit}>
      <label className="field">
        <span>{labels.regionName}</span>
        <input data-testid="region-name" required {...form.register("name")} />
        <ErrorText testId="region-name-error">
          {firstClientError(form.formState.errors.name) ?? fieldError(state, "name")}
        </ErrorText>
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.regionCode}</span>
          <input data-testid="region-code" {...form.register("code")} />
        </label>
        <label className="field">
          <span>{labels.sortOrder}</span>
          <input data-testid="region-sort-order" min={0} type="number" {...form.register("sortOrder")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.regionDescription}</span>
        <textarea data-testid="region-description" rows={3} {...form.register("description")} />
      </label>
      <FormMessage labels={labels} state={state} testId="region-form-message" />
      <button className="primary-button" data-testid="region-submit" disabled={pending} type="submit">
        {pending ? labels.saving : labels.saveRegion}
      </button>
    </form>
  );
}

export function CityCreateForm({
  labels,
  locale,
  regions
}: {
  labels: GeographyLabels;
  locale: string;
  regions: RegionSummary[];
}) {
  const schema = useMemo(
    () =>
      z.object({
        countryCode: z.string().trim().length(2, labels.validation),
        name: z.string().trim().min(1, labels.validation),
        regionId: z.string().optional(),
        sortOrder: z.coerce.number().min(0, labels.validation),
        timezone: z.string().trim().min(1, labels.validation)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      countryCode: "MA",
      name: "",
      regionId: regions[0]?.id ?? "",
      sortOrder: 0,
      timezone: "Africa/Casablanca"
    }
  });
  const [state, formAction, pending] = useActionState(createCityAction.bind(null, locale), initialState);
  const validateSubmit = useServerActionValidation(form, formAction);

  return (
    <form className="resource-form" action={formAction} data-testid="city-create-form" onSubmit={validateSubmit}>
      <label className="field">
        <span>{labels.cityName}</span>
        <input data-testid="city-name" required {...form.register("name")} />
        <ErrorText testId="city-name-error">
          {firstClientError(form.formState.errors.name) ?? fieldError(state, "name")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{labels.cityRegion}</span>
        <select data-testid="city-region" {...form.register("regionId")}>
          <option value="">{labels.noRegion}</option>
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.cityCountry}</span>
          <input data-testid="city-country-code" maxLength={2} required {...form.register("countryCode")} />
        </label>
        <label className="field">
          <span>{labels.cityTimezone}</span>
          <input data-testid="city-timezone" required {...form.register("timezone")} />
        </label>
        <label className="field">
          <span>{labels.sortOrder}</span>
          <input data-testid="city-sort-order" min={0} type="number" {...form.register("sortOrder")} />
        </label>
      </div>
      <FormMessage labels={labels} state={state} testId="city-form-message" />
      <button className="primary-button" data-testid="city-submit" disabled={pending} type="submit">
        {pending ? labels.saving : labels.saveCity}
      </button>
    </form>
  );
}

export function RegionArchiveForm({
  labels,
  locale,
  region
}: {
  labels: GeographyLabels;
  locale: string;
  region: RegionSummary;
}) {
  const [state, formAction, pending] = useActionState(
    archiveRegionAction.bind(null, locale),
    initialState
  );

  return (
    <form action={formAction} className="inline-action-form">
      <input name="regionId" type="hidden" value={region.id} />
      <button className="quiet-button" data-testid={`region-archive-${region.id}`} disabled={pending} type="submit">
        {labels.archive}
      </button>
      <FormMessage labels={labels} state={state} testId={`region-archive-message-${region.id}`} />
    </form>
  );
}

export function CityArchiveForm({
  city,
  labels,
  locale
}: {
  city: CitySummary;
  labels: GeographyLabels;
  locale: string;
}) {
  const [state, formAction, pending] = useActionState(archiveCityAction.bind(null, locale), initialState);

  return (
    <form action={formAction} className="inline-action-form">
      <input name="cityId" type="hidden" value={city.id} />
      <button className="quiet-button" data-testid={`city-archive-${city.id}`} disabled={pending} type="submit">
        {labels.archive}
      </button>
      <FormMessage labels={labels} state={state} testId={`city-archive-message-${city.id}`} />
    </form>
  );
}
