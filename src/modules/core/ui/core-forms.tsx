"use client";

import { useActionState, useMemo, useState, type FormEvent, type SelectHTMLAttributes } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import { appLocales, compactLocaleLabels } from "@/i18n/routing";
import type { CoreFormState } from "@/modules/core/application/core-actions";
import {
  createOwnerAction,
  createPropertyAction,
  updatePropertyOperatingProfileAction,
  updatePropertyOwnershipAction
} from "@/modules/core/application/core-actions";
import type { PropertyOperatingCadence, PropertyOperatingProfileSummary } from "@/modules/core/domain/owner-property";

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
  representativeSection: string;
  representativeDisplayName: string;
  representativeEmail: string;
  representativePhone: string;
  representativeRelationship: string;
  representativeAccessNotes: string;
  representativeValidFrom: string;
  representativeValidTo: string;
  payoutSection: string;
  payoutLabel: string;
  payoutMethodType: string;
  payoutAccountHolderName: string;
  payoutCurrency: string;
  payoutCountryCode: string;
  payoutDetails: string;
  payoutIsDefault: string;
  saveOwner: string;
};

type PropertyLabels = FormLabels & {
  owner: string;
  noOwners: string;
  noCities: string;
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
  onboardingSection: string;
  headline: string;
  description: string;
  publicDirections: string;
  internalAccessNotes: string;
  houseRules: string;
  onboardingNotes: string;
  operatingSection: string;
  cleaning: string;
  inspection: string;
  poolService: string;
  gardenService: string;
  laundry: string;
  linen: string;
  maintenance: string;
  preventiveMaintenance: string;
  midStayCleaning: string;
  midStayRuleKey: string;
  breakfast: string;
  chef: string;
  transfers: string;
  groceries: string;
  wellness: string;
  otherServices: string;
  automationNotes: string;
  cadence: string;
  cadenceOptions: Record<PropertyOperatingCadence, string>;
  saveProperty: string;
};

type PropertyOperatingProfileLabels = FormLabels & {
  automationNotes: string;
  breakfast: string;
  cadence: string;
  cadenceOptions: Record<PropertyOperatingCadence, string>;
  chef: string;
  cleaning: string;
  formTitle: string;
  gardenService: string;
  groceries: string;
  inspection: string;
  laundry: string;
  linen: string;
  maintenance: string;
  midStayCleaning: string;
  midStayRuleKey: string;
  otherServices: string;
  poolService: string;
  preventiveMaintenance: string;
  save: string;
  saved: string;
  transfers: string;
  wellness: string;
};

type PropertyOwnershipLabels = FormLabels & {
  addOwner: string;
  owner: string;
  ownershipSection: string;
  primary: string;
  removeOwner: string;
  saved: string;
  saveOwnership: string;
  sharePercent: string;
  shareTotal: string;
  shareTotalInvalid: string;
};

type OwnerOption = {
  id: string;
  displayName: string;
};

type CityOption = {
  id: string;
  name: string;
  regionName: string | null;
};

type PropertyOwnerLink = {
  id: string;
  displayName: string;
  shareBps: number;
  isPrimary: boolean;
};

type OwnershipFormRow = {
  key: string;
  ownerId: string;
  sharePercent: string;
  isPrimary: boolean;
};

const operatingCadences: PropertyOperatingCadence[] = [
  "NONE",
  "ON_DEMAND",
  "BETWEEN_STAYS",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "CHECKIN",
  "CHECKOUT",
  "CUSTOM_RULE"
];

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

function bpsToPercent(shareBps: number): string {
  return (shareBps / 100).toFixed(2).replace(/\.00$/u, "");
}

function percentToClientBps(value: string): number {
  const match = /^(?<whole>\d{1,3})(?:\.(?<fraction>\d{1,2}))?$/u.exec(value.trim());

  if (!match?.groups) {
    return Number.NaN;
  }

  return Number.parseInt(match.groups.whole, 10) * 100 +
    Number.parseInt((match.groups.fraction ?? "").padEnd(2, "0"), 10);
}

function CadenceSelect({
  labels,
  selectProps,
  testId
}: {
  labels: Pick<PropertyLabels, "cadence" | "cadenceOptions"> | Pick<PropertyOperatingProfileLabels, "cadence" | "cadenceOptions">;
  selectProps: SelectHTMLAttributes<HTMLSelectElement> & { name: string };
  testId?: string;
}) {
  return (
    <label className="field">
      <span>{labels.cadence}</span>
      <select data-testid={testId} {...selectProps}>
        {operatingCadences.map((cadence) => (
          <option key={cadence} value={cadence}>
            {labels.cadenceOptions[cadence]}
          </option>
        ))}
      </select>
    </label>
  );
}

function otherServicesText(profile: PropertyOperatingProfileSummary): string {
  return profile.otherServices.join(", ");
}

export function OwnerCreateForm({ locale, labels }: LocalizedFormProps<OwnerLabels>) {
  const schema = useMemo(
    () =>
      z.object({
        displayName: z.string().trim().min(1, labels.validation),
        email: z.string().trim().email(labels.validation).or(z.literal("")),
        legalName: z.string().optional(),
        notes: z.string().optional(),
        payoutAccountHolderName: z.string().optional(),
        payoutCountryCode: z.string().optional(),
        payoutCurrency: z.string().optional(),
        payoutDetails: z.string().optional(),
        payoutIsDefault: z.boolean().optional(),
        payoutLabel: z.string().optional(),
        payoutMethodType: z.enum(["BANK_TRANSFER", "WISE", "CASH", "CHEQUE", "OTHER"]),
        phone: z.string().optional(),
        preferredLocale: z.enum(appLocales)
          .or(z.literal("")),
        representativeAccessNotes: z.string().optional(),
        representativeDisplayName: z.string().optional(),
        representativeEmail: z.string().trim().email(labels.validation).or(z.literal("")),
        representativePhone: z.string().optional(),
        representativePreferredLocale: z.enum(appLocales),
        representativeRelationship: z.string().optional(),
        representativeValidFrom: z.string().optional(),
        representativeValidTo: z.string().optional()
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      displayName: "",
      email: "",
      legalName: "",
      notes: "",
      payoutAccountHolderName: "",
      payoutCountryCode: "MA",
      payoutCurrency: "MAD",
      payoutDetails: "",
      payoutIsDefault: true,
      payoutLabel: "",
      payoutMethodType: "BANK_TRANSFER",
      phone: "",
      preferredLocale: "fr",
      representativeAccessNotes: "",
      representativeDisplayName: "",
      representativeEmail: "",
      representativePhone: "",
      representativePreferredLocale: "fr",
      representativeRelationship: "",
      representativeValidFrom: "",
      representativeValidTo: ""
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
      <div className="subsection-block">
        <p className="panel-label">{labels.representativeSection}</p>
        <label className="field">
          <span>{labels.representativeDisplayName}</span>
          <input data-testid="owner-representative-display-name" {...form.register("representativeDisplayName")} />
        </label>
        <div className="form-grid two">
          <label className="field">
            <span>{labels.representativeEmail}</span>
            <input autoComplete="email" type="email" {...form.register("representativeEmail")} />
          </label>
          <label className="field">
            <span>{labels.representativePhone}</span>
            <input autoComplete="tel" {...form.register("representativePhone")} />
          </label>
        </div>
        <div className="form-grid two">
          <label className="field">
            <span>{labels.representativeRelationship}</span>
            <input {...form.register("representativeRelationship")} />
          </label>
          <label className="field">
            <span>{labels.preferredLocale}</span>
            <select {...form.register("representativePreferredLocale")}>
              {appLocales.map((appLocale) => (
                <option key={appLocale} value={appLocale}>
                  {compactLocaleLabels[appLocale]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid two">
          <label className="field">
            <span>{labels.representativeValidFrom}</span>
            <input type="date" {...form.register("representativeValidFrom")} />
          </label>
          <label className="field">
            <span>{labels.representativeValidTo}</span>
            <input type="date" {...form.register("representativeValidTo")} />
          </label>
        </div>
        <label className="field">
          <span>{labels.representativeAccessNotes}</span>
          <textarea rows={3} {...form.register("representativeAccessNotes")} />
        </label>
      </div>
      <div className="subsection-block">
        <p className="panel-label">{labels.payoutSection}</p>
        <div className="form-grid two">
          <label className="field">
            <span>{labels.payoutLabel}</span>
            <input data-testid="owner-payout-label" {...form.register("payoutLabel")} />
          </label>
          <label className="field">
            <span>{labels.payoutMethodType}</span>
            <select {...form.register("payoutMethodType")}>
              {["BANK_TRANSFER", "WISE", "CASH", "CHEQUE", "OTHER"].map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{labels.payoutAccountHolderName}</span>
          <input data-testid="owner-payout-account-holder" {...form.register("payoutAccountHolderName")} />
        </label>
        <div className="form-grid two">
          <label className="field">
            <span>{labels.payoutCurrency}</span>
            <input maxLength={3} {...form.register("payoutCurrency")} />
          </label>
          <label className="field">
            <span>{labels.payoutCountryCode}</span>
            <input maxLength={2} {...form.register("payoutCountryCode")} />
          </label>
        </div>
        <label className="field">
          <span>{labels.payoutDetails}</span>
          <textarea data-testid="owner-payout-details" rows={4} {...form.register("payoutDetails")} />
        </label>
        <div className="check-row">
          <label>
            <input type="checkbox" {...form.register("payoutIsDefault")} />
            <span>{labels.payoutIsDefault}</span>
          </label>
        </div>
      </div>
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
  cities = [],
  locale,
  labels,
  owners
}: LocalizedFormProps<PropertyLabels> & { cities?: CityOption[]; owners: OwnerOption[] }) {
  const hasCities = cities.length > 0;
  const schema = useMemo(
    () =>
      z.object({
        addressLine1: z.string().trim().min(1, labels.validation),
        addressLine2: z.string().optional(),
        amenities: z.string().optional(),
        bathrooms: z.coerce.number().min(0, labels.validation),
        bedrooms: z.coerce.number().min(0, labels.validation),
        city: hasCities ? z.string().optional() : z.string().trim().min(1, labels.validation),
        cityId: hasCities ? z.string().trim().min(1, labels.validation) : z.string().optional(),
        countryCode: z.string().trim().length(2, labels.validation),
        automationNotes: z.string().optional(),
        breakfastAvailable: z.boolean().optional(),
        chefAvailable: z.boolean().optional(),
        cleaningEnabled: z.boolean().optional(),
        cleaningFrequency: z.string().trim().min(1, labels.validation),
        description: z.string().optional(),
        gardenServiceEnabled: z.boolean().optional(),
        gardenServiceFrequency: z.string().trim().min(1, labels.validation),
        groceriesAvailable: z.boolean().optional(),
        hasGarden: z.boolean().optional(),
        hasPool: z.boolean().optional(),
        headline: z.string().optional(),
        houseRules: z.string().optional(),
        inspectionEnabled: z.boolean().optional(),
        inspectionFrequency: z.string().trim().min(1, labels.validation),
        internalAccessNotes: z.string().optional(),
        laundryManaged: z.boolean().optional(),
        linenManaged: z.boolean().optional(),
        livingSpaces: z.coerce.number().min(0, labels.validation),
        maintenanceTrackingEnabled: z.boolean().optional(),
        maxGuests: z.coerce.number().min(1, labels.validation),
        midStayCleaningEnabled: z.boolean().optional(),
        midStayCleaningRuleKey: z.string().optional(),
        name: z.string().trim().min(1, labels.validation),
        onboardingNotes: z.string().optional(),
        otherServices: z.string().optional(),
        ownerId: z.string().trim().min(1, labels.validation),
        parkingSpaces: z.coerce.number().min(0, labels.validation),
        photoUrls: z.string().optional(),
        poolServiceEnabled: z.boolean().optional(),
        poolServiceFrequency: z.string().trim().min(1, labels.validation),
        preventiveMaintenanceFrequency: z.string().trim().min(1, labels.validation),
        propertyType: z.string().trim().min(1, labels.validation),
        publicDirections: z.string().optional(),
        region: z.string().optional(),
        transfersAvailable: z.boolean().optional(),
        wellnessAvailable: z.boolean().optional(),
        timezone: z.string().trim().min(1, labels.validation)
      }),
    [hasCities, labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      addressLine1: "",
      addressLine2: "",
      amenities: "",
      bathrooms: 0,
      bedrooms: 0,
      city: "",
      cityId: cities[0]?.id ?? "",
      countryCode: "MA",
      automationNotes: "",
      breakfastAvailable: false,
      chefAvailable: false,
      cleaningEnabled: true,
      cleaningFrequency: "BETWEEN_STAYS",
      description: "",
      gardenServiceEnabled: false,
      gardenServiceFrequency: "NONE",
      groceriesAvailable: false,
      hasGarden: false,
      hasPool: false,
      headline: "",
      houseRules: "",
      inspectionEnabled: true,
      inspectionFrequency: "CHECKOUT",
      internalAccessNotes: "",
      laundryManaged: true,
      linenManaged: true,
      livingSpaces: 1,
      maintenanceTrackingEnabled: true,
      maxGuests: 1,
      midStayCleaningEnabled: false,
      midStayCleaningRuleKey: "ops.mid_stay_threshold",
      name: "",
      onboardingNotes: "",
      otherServices: "",
      parkingSpaces: 0,
      photoUrls: "",
      poolServiceEnabled: false,
      poolServiceFrequency: "NONE",
      preventiveMaintenanceFrequency: "ON_DEMAND",
      propertyType: "",
      publicDirections: "",
      region: "",
      transfersAvailable: false,
      wellnessAvailable: false,
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
        {hasCities ? (
          <label className="field">
            <span>{labels.city}</span>
            <select data-testid="property-city-id" required {...form.register("cityId")}>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.regionName ? `${city.name} / ${city.regionName}` : city.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="field">
              <span>{labels.city}</span>
              <input data-testid="property-city" required {...form.register("city")} />
              <p className="field-hint">{labels.noCities}</p>
            </label>
            <label className="field">
              <span>{labels.region}</span>
              <input {...form.register("region")} />
            </label>
          </>
        )}
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
      <div className="subsection-block">
        <p className="panel-label">{labels.operatingSection}</p>
        <div className="operating-grid">
          <div className="operating-service-row">
            <label className="choice-row">
              <input data-testid="property-operating-cleaning" type="checkbox" {...form.register("cleaningEnabled")} />
              <span>{labels.cleaning}</span>
            </label>
            <CadenceSelect
              labels={labels}
              selectProps={{ ...form.register("cleaningFrequency"), name: "cleaningFrequency" }}
              testId="property-operating-cleaning-frequency"
            />
          </div>
          <div className="operating-service-row">
            <label className="choice-row">
              <input data-testid="property-operating-inspection" type="checkbox" {...form.register("inspectionEnabled")} />
              <span>{labels.inspection}</span>
            </label>
            <CadenceSelect
              labels={labels}
              selectProps={{ ...form.register("inspectionFrequency"), name: "inspectionFrequency" }}
              testId="property-operating-inspection-frequency"
            />
          </div>
          <div className="operating-service-row">
            <label className="choice-row">
              <input data-testid="property-operating-pool" type="checkbox" {...form.register("poolServiceEnabled")} />
              <span>{labels.poolService}</span>
            </label>
            <CadenceSelect
              labels={labels}
              selectProps={{ ...form.register("poolServiceFrequency"), name: "poolServiceFrequency" }}
              testId="property-operating-pool-frequency"
            />
          </div>
          <div className="operating-service-row">
            <label className="choice-row">
              <input data-testid="property-operating-garden" type="checkbox" {...form.register("gardenServiceEnabled")} />
              <span>{labels.gardenService}</span>
            </label>
            <CadenceSelect
              labels={labels}
              selectProps={{ ...form.register("gardenServiceFrequency"), name: "gardenServiceFrequency" }}
              testId="property-operating-garden-frequency"
            />
          </div>
          <div className="operating-service-row">
            <label className="choice-row">
              <input
                data-testid="property-operating-maintenance"
                type="checkbox"
                {...form.register("maintenanceTrackingEnabled")}
              />
              <span>{labels.maintenance}</span>
            </label>
            <CadenceSelect
              labels={labels}
              selectProps={{ ...form.register("preventiveMaintenanceFrequency"), name: "preventiveMaintenanceFrequency" }}
              testId="property-operating-maintenance-frequency"
            />
          </div>
        </div>
        <div className="check-row">
          <label>
            <input data-testid="property-operating-laundry" type="checkbox" {...form.register("laundryManaged")} />
            <span>{labels.laundry}</span>
          </label>
          <label>
            <input data-testid="property-operating-linen" type="checkbox" {...form.register("linenManaged")} />
            <span>{labels.linen}</span>
          </label>
          <label>
            <input data-testid="property-operating-midstay" type="checkbox" {...form.register("midStayCleaningEnabled")} />
            <span>{labels.midStayCleaning}</span>
          </label>
        </div>
        <label className="field">
          <span>{labels.midStayRuleKey}</span>
          <input data-testid="property-operating-midstay-rule" {...form.register("midStayCleaningRuleKey")} />
        </label>
        <div className="check-row">
          <label>
            <input data-testid="property-operating-breakfast" type="checkbox" {...form.register("breakfastAvailable")} />
            <span>{labels.breakfast}</span>
          </label>
          <label>
            <input data-testid="property-operating-chef" type="checkbox" {...form.register("chefAvailable")} />
            <span>{labels.chef}</span>
          </label>
          <label>
            <input data-testid="property-operating-transfers" type="checkbox" {...form.register("transfersAvailable")} />
            <span>{labels.transfers}</span>
          </label>
          <label>
            <input data-testid="property-operating-groceries" type="checkbox" {...form.register("groceriesAvailable")} />
            <span>{labels.groceries}</span>
          </label>
          <label>
            <input data-testid="property-operating-wellness" type="checkbox" {...form.register("wellnessAvailable")} />
            <span>{labels.wellness}</span>
          </label>
        </div>
        <label className="field">
          <span>{labels.otherServices}</span>
          <textarea data-testid="property-operating-other-services" rows={2} {...form.register("otherServices")} />
        </label>
        <label className="field">
          <span>{labels.automationNotes}</span>
          <textarea data-testid="property-operating-notes" rows={3} {...form.register("automationNotes")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.amenities}</span>
        <textarea data-testid="property-amenities" rows={3} {...form.register("amenities")} />
      </label>
      <label className="field">
        <span>{labels.photoUrls}</span>
        <textarea data-testid="property-photo-urls" rows={3} {...form.register("photoUrls")} />
        <ErrorText testId="property-photo-urls-error">{fieldError(state, "photoUrls")}</ErrorText>
      </label>
      <div className="subsection-block">
        <p className="panel-label">{labels.onboardingSection}</p>
        <label className="field">
          <span>{labels.headline}</span>
          <input data-testid="property-headline" {...form.register("headline")} />
        </label>
        <label className="field">
          <span>{labels.description}</span>
          <textarea rows={4} {...form.register("description")} />
        </label>
        <label className="field">
          <span>{labels.publicDirections}</span>
          <textarea data-testid="property-public-directions" rows={3} {...form.register("publicDirections")} />
        </label>
        <label className="field">
          <span>{labels.internalAccessNotes}</span>
          <textarea data-testid="property-internal-access-notes" rows={3} {...form.register("internalAccessNotes")} />
        </label>
        <label className="field">
          <span>{labels.houseRules}</span>
          <textarea data-testid="property-house-rules" rows={3} {...form.register("houseRules")} />
        </label>
        <label className="field">
          <span>{labels.onboardingNotes}</span>
          <textarea data-testid="property-onboarding-notes" rows={3} {...form.register("onboardingNotes")} />
        </label>
      </div>
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

export function PropertyOwnershipForm({
  labels,
  locale,
  ownerOptions,
  propertyId,
  shares
}: LocalizedFormProps<PropertyOwnershipLabels> & {
  ownerOptions: OwnerOption[];
  propertyId: string;
  shares: PropertyOwnerLink[];
}) {
  const initialRows = useMemo<OwnershipFormRow[]>(
    () =>
      shares.length > 0
        ? shares.map((share) => ({
            key: share.id,
            ownerId: share.id,
            sharePercent: bpsToPercent(share.shareBps),
            isPrimary: share.isPrimary
          }))
        : ownerOptions.slice(0, 1).map((owner) => ({
            key: owner.id,
            ownerId: owner.id,
            sharePercent: "100",
            isPrimary: true
          })),
    [ownerOptions, shares]
  );
  const [rows, setRows] = useState<OwnershipFormRow[]>(initialRows);
  const [clientError, setClientError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(
    updatePropertyOwnershipAction.bind(null, locale, propertyId),
    initialCoreFormState
  );
  const totalBps = rows.reduce((sum, row) => sum + (Number.isNaN(percentToClientBps(row.sharePercent))
    ? 0
    : percentToClientBps(row.sharePercent)), 0);
  const hasOwnerOptions = ownerOptions.length > 0;
  const message = messageForState(state, labels);

  function addRow() {
    const usedOwnerIds = new Set(rows.map((row) => row.ownerId));
    const nextOwner = ownerOptions.find((owner) => !usedOwnerIds.has(owner.id)) ?? ownerOptions[0];

    if (!nextOwner) {
      return;
    }

    setRows((currentRows) => [
      ...currentRows,
      {
        key: `${nextOwner.id}-${currentRows.length}`,
        ownerId: nextOwner.id,
        sharePercent: "0",
        isPrimary: currentRows.length === 0
      }
    ]);
  }

  function removeRow(rowKey: string) {
    setRows((currentRows) => {
      const nextRows = currentRows.filter((row) => row.key !== rowKey);

      if (nextRows.length === 0) {
        return currentRows;
      }

      if (!nextRows.some((row) => row.isPrimary)) {
        return nextRows.map((row, index) => ({ ...row, isPrimary: index === 0 }));
      }

      return nextRows;
    });
  }

  function updateRow(rowKey: string, patch: Partial<OwnershipFormRow>) {
    setRows((currentRows) =>
      currentRows.map((row) => (row.key === rowKey ? { ...row, ...patch } : row))
    );
  }

  function makePrimary(rowKey: string) {
    setRows((currentRows) => currentRows.map((row) => ({ ...row, isPrimary: row.key === rowKey })));
  }

  function validateSubmit(event: FormEvent<HTMLFormElement>) {
    const ownerIds = rows.map((row) => row.ownerId).filter(Boolean);
    const duplicateOwner = ownerIds.length !== new Set(ownerIds).size;
    const invalidShare = rows.some((row) => {
      const shareBps = percentToClientBps(row.sharePercent);

      return !Number.isInteger(shareBps) || shareBps <= 0 || shareBps > 10000;
    });

    if (rows.length === 0 || duplicateOwner || invalidShare || totalBps !== 10000 || rows.filter((row) => row.isPrimary).length !== 1) {
      event.preventDefault();
      setClientError(labels.shareTotalInvalid);
      return;
    }

    setClientError(null);
  }

  return (
    <form
      className="resource-form ownership-form"
      action={formAction}
      data-testid="property-ownership-form"
      onSubmit={validateSubmit}
    >
      <div className="section-heading">
        <p className="panel-label">{labels.ownershipSection}</p>
        <span data-testid="property-owner-share-total">
          {labels.shareTotal}: {(totalBps / 100).toFixed(2)}%
        </span>
      </div>
      {rows.map((row, index) => (
        <div className="ownership-row" data-testid="property-owner-share-row" key={row.key}>
          <label className="field">
            <span>{labels.owner}</span>
            <select
              data-testid="property-owner-share-owner"
              disabled={!hasOwnerOptions}
              name="ownershipOwnerId"
              onChange={(event) => updateRow(row.key, { ownerId: event.currentTarget.value })}
              required
              value={row.ownerId}
            >
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{labels.sharePercent}</span>
            <input
              data-testid="property-owner-share-percent"
              inputMode="decimal"
              min="0.01"
              max="100"
              name="ownershipSharePercent"
              onChange={(event) => updateRow(row.key, { sharePercent: event.currentTarget.value })}
              required
              step="0.01"
              type="number"
              value={row.sharePercent}
            />
          </label>
          <label className="choice-row">
            <input
              checked={row.isPrimary}
              data-testid="property-owner-share-primary"
              name="primaryOwnerId"
              onChange={() => makePrimary(row.key)}
              required
              type="radio"
              value={row.ownerId}
            />
            <span>{labels.primary}</span>
          </label>
          <button
            className="secondary-button"
            data-testid="property-owner-share-remove"
            disabled={rows.length === 1}
            onClick={() => removeRow(row.key)}
            type="button"
          >
            {labels.removeOwner}
          </button>
          <input name="ownershipRowIndex" type="hidden" value={index} />
        </div>
      ))}
      {clientError ? (
        <p className="form-error" data-testid="property-ownership-client-error" role="alert">
          {clientError}
        </p>
      ) : null}
      {message ? (
        <p className="form-error" data-testid="property-ownership-form-error" role="alert">
          {message}
        </p>
      ) : null}
      {state.status === "success" ? (
        <p className="form-success" data-testid="property-ownership-form-success" role="status">
          {labels.saved}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          className="secondary-button"
          data-testid="property-owner-share-add"
          disabled={!hasOwnerOptions || rows.length >= ownerOptions.length}
          type="button"
          onClick={addRow}
        >
          {labels.addOwner}
        </button>
        <button
          className="primary-button"
          data-testid="property-owner-share-submit"
          disabled={pending || !hasOwnerOptions}
          type="submit"
        >
          {pending ? labels.saving : labels.saveOwnership}
        </button>
      </div>
    </form>
  );
}

export function PropertyOperatingProfileForm({
  labels,
  locale,
  profile,
  propertyId
}: LocalizedFormProps<PropertyOperatingProfileLabels> & {
  profile: PropertyOperatingProfileSummary;
  propertyId: string;
}) {
  const [state, formAction, pending] = useActionState(
    updatePropertyOperatingProfileAction.bind(null, locale, propertyId),
    initialCoreFormState
  );
  const message = messageForState(state, labels);

  return (
    <form
      className="resource-form operating-profile-form"
      action={formAction}
      data-testid="property-operating-profile-form"
    >
      <p className="panel-label">{labels.formTitle}</p>
      <div className="operating-grid">
        <div className="operating-service-row">
          <label className="choice-row">
            <input
              data-testid="property-operating-cleaning"
              defaultChecked={profile.cleaningEnabled}
              name="cleaningEnabled"
              type="checkbox"
            />
            <span>{labels.cleaning}</span>
          </label>
          <CadenceSelect
            labels={labels}
            selectProps={{
              defaultValue: profile.cleaningFrequency,
              name: "cleaningFrequency"
            }}
            testId="property-operating-cleaning-frequency"
          />
        </div>
        <div className="operating-service-row">
          <label className="choice-row">
            <input
              data-testid="property-operating-inspection"
              defaultChecked={profile.inspectionEnabled}
              name="inspectionEnabled"
              type="checkbox"
            />
            <span>{labels.inspection}</span>
          </label>
          <CadenceSelect
            labels={labels}
            selectProps={{
              defaultValue: profile.inspectionFrequency,
              name: "inspectionFrequency"
            }}
            testId="property-operating-inspection-frequency"
          />
        </div>
        <div className="operating-service-row">
          <label className="choice-row">
            <input
              data-testid="property-operating-pool"
              defaultChecked={profile.poolServiceEnabled}
              name="poolServiceEnabled"
              type="checkbox"
            />
            <span>{labels.poolService}</span>
          </label>
          <CadenceSelect
            labels={labels}
            selectProps={{
              defaultValue: profile.poolServiceFrequency,
              name: "poolServiceFrequency"
            }}
            testId="property-operating-pool-frequency"
          />
        </div>
        <div className="operating-service-row">
          <label className="choice-row">
            <input
              data-testid="property-operating-garden"
              defaultChecked={profile.gardenServiceEnabled}
              name="gardenServiceEnabled"
              type="checkbox"
            />
            <span>{labels.gardenService}</span>
          </label>
          <CadenceSelect
            labels={labels}
            selectProps={{
              defaultValue: profile.gardenServiceFrequency,
              name: "gardenServiceFrequency"
            }}
            testId="property-operating-garden-frequency"
          />
        </div>
        <div className="operating-service-row">
          <label className="choice-row">
            <input
              data-testid="property-operating-maintenance"
              defaultChecked={profile.maintenanceTrackingEnabled}
              name="maintenanceTrackingEnabled"
              type="checkbox"
            />
            <span>{labels.maintenance}</span>
          </label>
          <CadenceSelect
            labels={labels}
            selectProps={{
              defaultValue: profile.preventiveMaintenanceFrequency,
              name: "preventiveMaintenanceFrequency"
            }}
            testId="property-operating-maintenance-frequency"
          />
        </div>
      </div>
      <div className="check-row">
        <label>
          <input
            data-testid="property-operating-laundry"
            defaultChecked={profile.laundryManaged}
            name="laundryManaged"
            type="checkbox"
          />
          <span>{labels.laundry}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-linen"
            defaultChecked={profile.linenManaged}
            name="linenManaged"
            type="checkbox"
          />
          <span>{labels.linen}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-midstay"
            defaultChecked={profile.midStayCleaningEnabled}
            name="midStayCleaningEnabled"
            type="checkbox"
          />
          <span>{labels.midStayCleaning}</span>
        </label>
      </div>
      <label className="field">
        <span>{labels.midStayRuleKey}</span>
        <input
          data-testid="property-operating-midstay-rule"
          defaultValue={profile.midStayCleaningRuleKey ?? "ops.mid_stay_threshold"}
          name="midStayCleaningRuleKey"
        />
      </label>
      <div className="check-row">
        <label>
          <input
            data-testid="property-operating-breakfast"
            defaultChecked={profile.breakfastAvailable}
            name="breakfastAvailable"
            type="checkbox"
          />
          <span>{labels.breakfast}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-chef"
            defaultChecked={profile.chefAvailable}
            name="chefAvailable"
            type="checkbox"
          />
          <span>{labels.chef}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-transfers"
            defaultChecked={profile.transfersAvailable}
            name="transfersAvailable"
            type="checkbox"
          />
          <span>{labels.transfers}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-groceries"
            defaultChecked={profile.groceriesAvailable}
            name="groceriesAvailable"
            type="checkbox"
          />
          <span>{labels.groceries}</span>
        </label>
        <label>
          <input
            data-testid="property-operating-wellness"
            defaultChecked={profile.wellnessAvailable}
            name="wellnessAvailable"
            type="checkbox"
          />
          <span>{labels.wellness}</span>
        </label>
      </div>
      <label className="field">
        <span>{labels.otherServices}</span>
        <textarea data-testid="property-operating-other-services" defaultValue={otherServicesText(profile)} name="otherServices" rows={2} />
      </label>
      <label className="field">
        <span>{labels.automationNotes}</span>
        <textarea data-testid="property-operating-notes" defaultValue={profile.automationNotes ?? ""} name="automationNotes" rows={3} />
      </label>
      {message ? (
        <p className="form-error" data-testid="property-operating-profile-form-error" role="alert">
          {message}
        </p>
      ) : null}
      {state.status === "success" ? (
        <p className="form-success" data-testid="property-operating-profile-form-success" role="status">
          {labels.saved}
        </p>
      ) : null}
      <button
        className="primary-button"
        data-testid="property-operating-profile-submit"
        disabled={pending}
        type="submit"
      >
        {pending ? labels.saving : labels.save}
      </button>
    </form>
  );
}
