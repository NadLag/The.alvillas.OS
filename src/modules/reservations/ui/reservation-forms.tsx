"use client";

import { useActionState } from "react";
import type {
  FieldTaskFormState,
  ReservationFormState
} from "@/modules/reservations/application/reservation-actions";
import {
  completeFieldTaskAction,
  createManualReservationAction
} from "@/modules/reservations/application/reservation-actions";

type FormLabels = {
  saving: string;
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  config: string;
  conflict?: string;
  generic: string;
};

type ReservationLabels = FormLabels & {
  property: string;
  noProperties: string;
  guestName: string;
  guestEmail: string;
  source: string;
  checkIn: string;
  checkOut: string;
  adultCount: string;
  childCount: string;
  notes: string;
  saveReservation: string;
};

type PropertyOption = {
  id: string;
  name: string;
  city: string;
};

type ChecklistItemOption = {
  id: string;
  label: Record<string, string>;
  completed: boolean;
};

const initialReservationFormState: ReservationFormState = { status: "idle" };
const initialFieldTaskFormState: FieldTaskFormState = { status: "idle" };

function messageForState(state: ReservationFormState, labels: FormLabels): string | null {
  switch (state.messageKey) {
    case "validation":
      return labels.validation;
    case "unauthorized":
      return labels.unauthorized;
    case "forbidden":
      return labels.forbidden;
    case "notFound":
      return labels.notFound;
    case "config":
      return labels.config;
    case "conflict":
      return labels.conflict ?? labels.generic;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

type FieldTaskLabels = FormLabels & {
  complete: string;
  completing: string;
  note: string;
};

function localizedLabel(label: Record<string, string>, locale: string): string {
  return label[locale] ?? label.en ?? Object.values(label)[0] ?? "";
}

export function FieldTaskCompletionForm({
  locale,
  taskId,
  checklistItems,
  labels
}: {
  locale: string;
  taskId: string;
  checklistItems: ChecklistItemOption[];
  labels: FieldTaskLabels;
}) {
  const [state, formAction, pending] = useActionState(
    completeFieldTaskAction.bind(null, locale),
    initialFieldTaskFormState
  );
  const message = messageForState(state, labels);

  return (
    <form className="field-checklist" action={formAction} data-testid="field-task-complete-form">
      <input name="taskId" type="hidden" value={taskId} />
      <div className="field-checklist-items">
        {checklistItems.map((item) => (
          <label className="field-checklist-item" key={item.id}>
            <input
              data-testid="field-checklist-item"
              defaultChecked={item.completed}
              disabled={item.completed}
              name="checklistItemIds"
              type="checkbox"
              value={item.id}
            />
            <span>{localizedLabel(item.label, locale)}</span>
          </label>
        ))}
      </div>
      <label className="field">
        <span>{labels.note}</span>
        <textarea name="note" rows={3} />
      </label>
      {message ? (
        <p className="form-error" data-testid="field-task-form-error" role="alert">
          {message}
        </p>
      ) : null}
      <button
        className="primary-button field-complete-button"
        data-testid="field-task-complete"
        disabled={pending}
        type="submit"
      >
        {pending ? labels.completing : labels.complete}
      </button>
    </form>
  );
}

function fieldError(state: ReservationFormState, field: string): string | null {
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

export function ManualReservationForm({
  locale,
  labels,
  properties,
  idempotencyKey
}: {
  locale: string;
  labels: ReservationLabels;
  properties: PropertyOption[];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    createManualReservationAction.bind(null, locale),
    initialReservationFormState
  );
  const message = messageForState(state, labels);
  const hasProperties = properties.length > 0;

  return (
    <form className="resource-form" action={formAction} data-testid="reservation-create-form">
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <input name="source" type="hidden" value="MANUAL" />
      <label className="field">
        <span>{labels.property}</span>
        <select data-testid="reservation-property" name="propertyId" required disabled={!hasProperties}>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name} - {property.city}
            </option>
          ))}
        </select>
        {!hasProperties ? <p className="field-hint">{labels.noProperties}</p> : null}
        <ErrorText testId="reservation-property-error">{fieldError(state, "propertyId")}</ErrorText>
      </label>
      <label className="field">
        <span>{labels.guestName}</span>
        <input data-testid="reservation-guest-name" name="guestName" required />
        <ErrorText testId="reservation-guest-name-error">{fieldError(state, "guestName")}</ErrorText>
      </label>
      <label className="field">
        <span>{labels.guestEmail}</span>
        <input autoComplete="email" data-testid="reservation-guest-email" name="guestEmail" type="email" />
        <ErrorText testId="reservation-guest-email-error">{fieldError(state, "guestEmail")}</ErrorText>
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.checkIn}</span>
          <input data-testid="reservation-check-in" name="checkIn" required type="date" />
          <ErrorText testId="reservation-check-in-error">{fieldError(state, "checkIn")}</ErrorText>
        </label>
        <label className="field">
          <span>{labels.checkOut}</span>
          <input data-testid="reservation-check-out" name="checkOut" required type="date" />
          <ErrorText testId="reservation-check-out-error">{fieldError(state, "checkOut")}</ErrorText>
        </label>
      </div>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.adultCount}</span>
          <input data-testid="reservation-adults" name="adultCount" type="number" min={0} defaultValue={2} />
        </label>
        <label className="field">
          <span>{labels.childCount}</span>
          <input data-testid="reservation-children" name="childCount" type="number" min={0} defaultValue={0} />
        </label>
      </div>
      <label className="field">
        <span>{labels.notes}</span>
        <textarea name="notes" rows={3} />
      </label>
      {message ? (
        <p className="form-error" data-testid="reservation-form-error" role="alert">
          {message}
        </p>
      ) : null}
      <button
        className="primary-button"
        data-testid="reservation-submit"
        disabled={pending || !hasProperties}
        type="submit"
      >
        {pending ? labels.saving : labels.saveReservation}
      </button>
    </form>
  );
}
