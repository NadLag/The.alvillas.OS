"use client";

import { useActionState } from "react";
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

export function OwnerCreateForm({ locale, labels }: LocalizedFormProps<OwnerLabels>) {
  const [state, formAction, pending] = useActionState(
    createOwnerAction.bind(null, locale),
    initialCoreFormState
  );
  const message = messageForState(state, labels);

  return (
    <form className="resource-form" action={formAction} data-testid="owner-create-form">
      <label className="field">
        <span>{labels.displayName}</span>
        <input data-testid="owner-display-name" name="displayName" required />
        <ErrorText testId="owner-display-name-error">{fieldError(state, "displayName")}</ErrorText>
      </label>
      <label className="field">
        <span>{labels.legalName}</span>
        <input name="legalName" />
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.email}</span>
          <input autoComplete="email" data-testid="owner-email" name="email" type="email" />
          <ErrorText testId="owner-email-error">{fieldError(state, "email")}</ErrorText>
        </label>
        <label className="field">
          <span>{labels.phone}</span>
          <input autoComplete="tel" name="phone" />
        </label>
      </div>
      <label className="field">
        <span>{labels.preferredLocale}</span>
        <select data-testid="owner-preferred-locale" name="preferredLocale" defaultValue="fr">
          {appLocales.map((appLocale) => (
            <option key={appLocale} value={appLocale}>
              {compactLocaleLabels[appLocale]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{labels.notes}</span>
        <textarea name="notes" rows={4} />
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
  const [state, formAction, pending] = useActionState(
    createPropertyAction.bind(null, locale),
    initialCoreFormState
  );
  const message = messageForState(state, labels);
  const hasOwners = owners.length > 0;

  return (
    <form className="resource-form" action={formAction} data-testid="property-create-form">
      <label className="field">
        <span>{labels.owner}</span>
        <select data-testid="property-owner" name="ownerId" required disabled={!hasOwners}>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.displayName}
            </option>
          ))}
        </select>
        {!hasOwners ? <p className="field-hint">{labels.noOwners}</p> : null}
        <ErrorText testId="property-owner-error">{fieldError(state, "ownerId")}</ErrorText>
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.name}</span>
          <input data-testid="property-name" name="name" required />
          <ErrorText testId="property-name-error">{fieldError(state, "name")}</ErrorText>
        </label>
        <label className="field">
          <span>{labels.propertyType}</span>
          <input data-testid="property-type" name="propertyType" required />
        </label>
      </div>
      <label className="field">
        <span>{labels.addressLine1}</span>
        <input data-testid="property-address" name="addressLine1" required />
      </label>
      <label className="field">
        <span>{labels.addressLine2}</span>
        <input name="addressLine2" />
      </label>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.city}</span>
          <input data-testid="property-city" name="city" required />
        </label>
        <label className="field">
          <span>{labels.region}</span>
          <input name="region" />
        </label>
        <label className="field">
          <span>{labels.countryCode}</span>
          <input name="countryCode" defaultValue="MA" required maxLength={2} />
        </label>
      </div>
      <div className="form-grid five">
        <label className="field">
          <span>{labels.bedrooms}</span>
          <input data-testid="property-bedrooms" name="bedrooms" type="number" min={0} required />
        </label>
        <label className="field">
          <span>{labels.bathrooms}</span>
          <input data-testid="property-bathrooms" name="bathrooms" type="number" min={0} required />
        </label>
        <label className="field">
          <span>{labels.livingSpaces}</span>
          <input name="livingSpaces" type="number" min={0} defaultValue={1} required />
        </label>
        <label className="field">
          <span>{labels.maxGuests}</span>
          <input data-testid="property-max-guests" name="maxGuests" type="number" min={1} required />
        </label>
        <label className="field">
          <span>{labels.parkingSpaces}</span>
          <input name="parkingSpaces" type="number" min={0} defaultValue={0} required />
        </label>
      </div>
      <label className="field">
        <span>{labels.timezone}</span>
        <input name="timezone" defaultValue="Africa/Casablanca" required />
      </label>
      <div className="check-row">
        <label>
          <input data-testid="property-has-pool" name="hasPool" type="checkbox" />
          <span>{labels.hasPool}</span>
        </label>
        <label>
          <input name="hasGarden" type="checkbox" />
          <span>{labels.hasGarden}</span>
        </label>
      </div>
      <label className="field">
        <span>{labels.amenities}</span>
        <textarea data-testid="property-amenities" name="amenities" rows={3} />
      </label>
      <label className="field">
        <span>{labels.photoUrls}</span>
        <textarea name="photoUrls" rows={3} />
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
