"use client";

import { useActionState, useMemo } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import { appLocales, compactLocaleLabels } from "@/i18n/routing";
import type { CoreFormState } from "@/modules/core/application/core-actions";
import {
  createOwnerAction,
  createPropertyAction
} from "@/modules/core/application/core-actions";

type FormLabels = {
  saving: string;
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  generic: string;
};

type OwnerLabels = FormLabels & {
  displayName: string;
  legalName: string;
  email: string;
  phone: string;
  preferredLocale: string;
  notes: string;
  saveOwner: string;
};

type PropertyLabels = FormLabels & {
  owner: string;
  noOwners: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  countryCode: string;
  propertyType: string;
  bedrooms: string;
  bathrooms: string;
  livingSpaces: string;
  maxGuests: string;
  parkingSpaces: string;
  timezone: string;
  hasPool: string;
  hasGarden: string;
  amenities: string;
  photoUrls: string;
  saveProperty: string;
};

type OwnerOption = {
  id: string;
  displayName: string;
};

const initialCoreFormState: CoreFormState = { status: "idle" };

type LocalizedFormProps<TLabels> = {
  locale: string;
  labels: TLabels;
};

function messageForState(state: CoreFormState, labels: FormLabels): string | null {
  switch (state.messageKey) {
    case "validation":
      return labels.validation;
    case "unauthorized":
      return labels.unauthorized;
    case "forbidden":
      return labels.forbidden;
    case "notFound":
      return labels.notFound;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function fieldError(state: CoreFormState, field: string): string | null {
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
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : null;
}

export function OwnerCreateForm({ locale, labels }: LocalizedFormProps<OwnerLabels>) {
  const schema = useMemo(
    () =>
      z.object({
        displayName: z.string().trim().min(1, labels.validation),
        email: z.string().trim().email(labels.validation).or(z.literal("")),
        legalName: z.string().optional(),
        notes: z.string().optional(),
        phone: z.string().optional(),
        preferredLocale: z.enum(appLocales)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      displayName: "",
      email: "",
      legalName: "",
      notes: "",
      phone: "",
      preferredLocale: "fr"
    }
  });
  const [state, formAction, pending] = useActionState(
    createOwnerAction.bind(null, locale),
    initialCoreFormState
  );
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);

  return (
    <form className="resource-form" action={formAction} data-testid="owner-create-form" onSubmit={validateSubmit}>
      <label className="field">
        <span>{labels.displayName}</span>
        <input data-testid="owner-display-name" required {...form.register("displayName")} />
        <ErrorText testId="owner-display-name-error">
          {firstClientError(form.formState.errors.displayName) ?? fieldError(state, "displayName")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{labels.legalName}</span>
        <input {...form.register("legalName")} />
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.email}</span>
          <input autoComplete="email" data-testid="owner-email" type="email" {...form.register("email")} />
          <ErrorText testId="owner-email-error">
            {firstClientError(form.formState.errors.email) ?? fieldError(state, "email")}
          </ErrorText>
        </label>
        <label className="field">
          <span>{labels.phone}</span>
          <input autoComplete="tel" {...form.register("phone")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.preferredLocale}</span>
        <select data-testid="owner-preferred-locale" {...form.register("preferredLocale")}>
          {appLocales.map((appLocale) => (
            <option key={appLocale} value={appLocale}>
              {compactLocaleLabels[appLocale]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{labels.notes}</span>
        <textarea rows={4} {...form.register("notes")} />
      </label>
      {message ? (
        <p className="form-error" data-testid="owner-form-error" role="alert">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="owner-submit" disabled={pending} type="submit">
        {pending ? labels.saving : labels.saveOwner}
      </button>
    </form>
  );
}

export function PropertyCreateForm({
  locale,
  labels,
  owners
}: LocalizedFormProps<PropertyLabels> & { owners: OwnerOption[] }) {
  const schema = useMemo(
    () =>
      z.object({
        addressLine1: z.string().trim().min(1, labels.validation),
        addressLine2: z.string().optional(),
        amenities: z.string().optional(),
        bathrooms: z.coerce.number().min(0, labels.validation),
        bedrooms: z.coerce.number().min(0, labels.validation),
        city: z.string().trim().min(1, labels.validation),
        countryCode: z.string().trim().length(2, labels.validation),
        hasGarden: z.boolean().optional(),
        hasPool: z.boolean().optional(),
        livingSpaces: z.coerce.number().min(0, labels.validation),
        maxGuests: z.coerce.number().min(1, labels.validation),
        name: z.string().trim().min(1, labels.validation),
        ownerId: z.string().trim().min(1, labels.validation),
        parkingSpaces: z.coerce.number().min(0, labels.validation),
        photoUrls: z.string().optional(),
        propertyType: z.string().trim().min(1, labels.validation),
        region: z.string().optional(),
        timezone: z.string().trim().min(1, labels.validation)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      addressLine1: "",
      addressLine2: "",
      amenities: "",
      bathrooms: 0,
      bedrooms: 0,
      city: "",
      countryCode: "MA",
      hasGarden: false,
      hasPool: false,
      livingSpaces: 1,
      maxGuests: 1,
      name: "",
      parkingSpaces: 0,
      photoUrls: "",
      propertyType: "",
      region: "",
      timezone: "Africa/Casablanca"
    }
  });
  const [state, formAction, pending] = useActionState(
    createPropertyAction.bind(null, locale),
    initialCoreFormState
  );
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);
  const hasOwners = owners.length > 0;

  return (
    <form className="resource-form" action={formAction} data-testid="property-create-form" onSubmit={validateSubmit}>
      <label className="field">
        <span>{labels.owner}</span>
        <select
          data-testid="property-owner"
          defaultValue={owners[0]?.id ?? ""}
          required
          disabled={!hasOwners}
          {...form.register("ownerId")}
        >
          {owners.map((owner) => (
            <option key={owner.id} label={owner.displayName} value={owner.id}>
              {owner.displayName}
            </option>
          ))}
        </select>
        {!hasOwners ? <p className="field-hint">{labels.noOwners}</p> : null}
        <ErrorText testId="property-owner-error">
          {firstClientError(form.formState.errors.ownerId) ?? fieldError(state, "ownerId")}
        </ErrorText>
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.name}</span>
          <input data-testid="property-name" required {...form.register("name")} />
          <ErrorText testId="property-name-error">
            {firstClientError(form.formState.errors.name) ?? fieldError(state, "name")}
          </ErrorText>
        </label>
        <label className="field">
          <span>{labels.propertyType}</span>
          <input data-testid="property-type" required {...form.register("propertyType")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.addressLine1}</span>
        <input data-testid="property-address" required {...form.register("addressLine1")} />
      </label>
      <label className="field">
        <span>{labels.addressLine2}</span>
        <input {...form.register("addressLine2")} />
      </label>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.city}</span>
          <input data-testid="property-city" required {...form.register("city")} />
        </label>
        <label className="field">
          <span>{labels.region}</span>
          <input {...form.register("region")} />
        </label>
        <label className="field">
          <span>{labels.countryCode}</span>
          <input required maxLength={2} {...form.register("countryCode")} />
        </label>
      </div>
      <div className="form-grid five">
        <label className="field">
          <span>{labels.bedrooms}</span>
          <input data-testid="property-bedrooms" type="number" min={0} required {...form.register("bedrooms")} />
        </label>
        <label className="field">
          <span>{labels.bathrooms}</span>
          <input data-testid="property-bathrooms" type="number" min={0} required {...form.register("bathrooms")} />
        </label>
        <label className="field">
          <span>{labels.livingSpaces}</span>
          <input type="number" min={0} required {...form.register("livingSpaces")} />
        </label>
        <label className="field">
          <span>{labels.maxGuests}</span>
          <input data-testid="property-max-guests" type="number" min={1} required {...form.register("maxGuests")} />
        </label>
        <label className="field">
          <span>{labels.parkingSpaces}</span>
          <input type="number" min={0} required {...form.register("parkingSpaces")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.timezone}</span>
        <input required {...form.register("timezone")} />
      </label>
      <div className="check-row">
        <label>
          <input data-testid="property-has-pool" type="checkbox" {...form.register("hasPool")} />
          <span>{labels.hasPool}</span>
        </label>
        <label>
          <input type="checkbox" {...form.register("hasGarden")} />
          <span>{labels.hasGarden}</span>
        </label>
      </div>
      <label className="field">
        <span>{labels.amenities}</span>
        <textarea data-testid="property-amenities" rows={3} {...form.register("amenities")} />
      </label>
      <label className="field">
        <span>{labels.photoUrls}</span>
        <textarea rows={3} {...form.register("photoUrls")} />
        <ErrorText testId="property-photo-urls-error">{fieldError(state, "photoUrls")}</ErrorText>
      </label>
      {message ? (
        <p className="form-error" data-testid="property-form-error" role="alert">
          {message}
        </p>
      ) : null}
      <button
        className="primary-button"
        data-testid="property-submit"
        disabled={pending || !hasOwners}
        type="submit"
      >
        {pending ? labels.saving : labels.saveProperty}
      </button>
    </form>
  );
}
