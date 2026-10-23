"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { useTranslations } from "next-intl";
import { optionalGuestPhoneSchema } from "@/platform/notifications/whatsapp";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import type {
  FieldTaskFormState,
  ReservationFormState
} from "@/modules/reservations/application/reservation-actions";
import {
  completeFieldTaskAction,
  createManualReservationAction
} from "@/modules/reservations/application/reservation-actions";
import { localizedChecklistLabel } from "@/modules/reservations/domain/reservation-task";
import { operationAction,type OperationFormState } from '../application/operation-actions';

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
  externalId: string;
  sources: Record<string, string>;
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

type FormState = ReservationFormState | FieldTaskFormState;

function messageForState(state: FormState, labels: FormLabels): string | null {
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
  offlineQueued: string;
  offlineSyncing: string;
  offlineSynced: string;
  offlineConflict: string;
  offlineRejected: string;
  offlineStorageError: string;
};

export function FieldTaskCompletionForm({
  locale,
  taskId,
  idempotencyKey,
  userId,
  organizationId,
  checklistItems,
  labels
}: {
  locale: string;
  taskId: string;
  idempotencyKey: string;
  userId: string;
  organizationId: string;
  checklistItems: ChecklistItemOption[];
  labels: FieldTaskLabels;
}) {
  const progressText=useTranslations('Operations.manage');
  const fieldText = useTranslations("Field");
  const [progress,progressAction,progressPending]=useActionState(operationAction.bind(null,locale,'progress'),{status:'idle'} as OperationFormState);
  const [checked,setChecked]=useState(()=>new Set(checklistItems.filter(i=>i.completed).map(i=>i.id)));
  const [state, formAction, pending] = useActionState(
    completeFieldTaskAction.bind(null, locale),
    initialFieldTaskFormState
  );
  const [queueStatus, setQueueStatus] = useState<
    "idle" | "queued" | "syncing" | "synced" | "conflict" | "rejected" | "storageError"
  >("idle");
  const syncing = useRef(false);
  const [note, setNote] = useState("");
  const [offline, setOffline] = useState(false);
  const message = messageForState(state, labels);
  const queued = queueStatus === "queued" || queueStatus === "syncing";
  const checkedCount = checklistItems.filter(item => checked.has(item.id)).length;
  const counterId = `field-checklist-progress-${taskId}`;

  useEffect(() => {
    let cancelled = false;
    const scope = { organizationId, userId };
    const ready = (async () => {
      const { fieldQueue } = await import("@/platform/offline/field-queue");
      const queue = fieldQueue();
      await queue.activate(scope);
      await queue.migrateLegacy(scope, localStorage);
      const current = (await queue.entries(scope)).find(item => item.operation.payload.taskId === taskId);
      if (current && !cancelled) {
        setQueueStatus(current.syncStatus === "pending" ? "queued" : current.syncStatus);
        setChecked(new Set(current.operation.payload.checklistItemIds));
        setNote(current.operation.payload.note ?? "");
      }
      return queue;
    })();
    async function sync(): Promise<void> {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const queue = await ready;
        if (cancelled || !navigator.onLine) return;
        const hadCurrent = (await queue.entries(scope)).some(item => item.operation.payload.taskId === taskId && item.syncStatus === "pending");
        if (hadCurrent) setQueueStatus("syncing");
        const { syncFieldQueue } = await import("@/platform/offline/field-queue");
        const result = await syncFieldQueue(queue, scope);
        if (cancelled || result === "idle") return;
        setQueueStatus(result);
      } catch {
        if (!cancelled) setQueueStatus("storageError");
      } finally { syncing.current = false; }
    }
    const handleSync = () => { if (!cancelled) { setOffline(!navigator.onLine); void sync(); } };
    const acknowledged = (value: unknown) => {
      if (!value || typeof value !== "object" || !("organizationId" in value) || value.organizationId !== organizationId ||
        !("userId" in value) || value.userId !== userId || !("taskId" in value) || value.taskId !== taskId || cancelled) return;
      window.location.assign(`/${locale}/app/field`);
    };
    const acknowledgedHere = (event: Event) => acknowledged((event as CustomEvent<unknown>).detail);
    const acknowledgedByWorker = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" && "type" in event.data && event.data.type === "alvillas-field-acknowledged" && "detail" in event.data) acknowledged(event.data.detail);
    };
    window.addEventListener("alvillas-field-acknowledged", acknowledgedHere);
    navigator.serviceWorker?.addEventListener("message", acknowledgedByWorker);
    queueMicrotask(handleSync);
    const retry = window.setInterval(handleSync, 30_000);
    window.addEventListener("online", handleSync);
    window.addEventListener("offline", handleSync);
    window.addEventListener("focus", handleSync);
    return () => {
      cancelled = true;
      window.clearInterval(retry);
      window.removeEventListener("online", handleSync);
      window.removeEventListener("offline", handleSync);
      window.removeEventListener("focus", handleSync);
      window.removeEventListener("alvillas-field-acknowledged", acknowledgedHere);
      navigator.serviceWorker?.removeEventListener("message", acknowledgedByWorker);
    };
  }, [locale, organizationId, userId, taskId]);

  async function queueCompletion(formData: FormData): Promise<void> {
    const checklistItemIds = formData.getAll("checklistItemIds").map(String);
    const noteValue = formData.get("note");
    const note = typeof noteValue === "string" ? noteValue.trim() : "";
    if (checklistItemIds.length !== checklistItems.length) { setQueueStatus("conflict"); return; }
    try {
      const { fieldQueue } = await import("@/platform/offline/field-queue");
      await fieldQueue().enqueue({ organizationId, userId }, { client_op_id: idempotencyKey,
        type: "field_task.complete", client_created_at: new Date().toISOString(),
        payload: { taskId, checklistItemIds, note: note || undefined } });
      setQueueStatus("queued");
      if (navigator.onLine) window.dispatchEvent(new Event("online"));
    } catch { setQueueStatus("storageError"); }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-progress") === "true") {
      if (!navigator.onLine) event.preventDefault();
      return;
    }
    if (navigator.onLine) return;
    event.preventDefault();
    void queueCompletion(new FormData(event.currentTarget));
  }

  const queueMessage =
    queueStatus === "queued"
      ? labels.offlineQueued
      : queueStatus === "syncing"
        ? labels.offlineSyncing
        : queueStatus === "synced"
          ? labels.offlineSynced
          : queueStatus === "conflict"
            ? labels.offlineConflict
            : queueStatus === "rejected"
              ? labels.offlineRejected
              : queueStatus === "storageError" ? labels.offlineStorageError : null;

  return (
    <form
      className="field-checklist"
      action={formAction}
      data-testid="field-task-complete-form"
      onReset={event => event.preventDefault()}
      data-field-dirty={!queued && (note.trim().length > 0 || checklistItems.some(item => item.completed !== checked.has(item.id))) ? "true" : undefined}
      onSubmit={handleSubmit}
    >
      <input name="taskId" type="hidden" value={taskId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <div className="field-checklist-progress">
        <p id={counterId} aria-live="polite" data-testid="field-checklist-progress">{progressText("progress", { done: checkedCount, total: checklistItems.length })}</p>
        {checklistItems.length ? <progress aria-labelledby={counterId} max={checklistItems.length} value={checkedCount} /> : null}
      </div>
      <div className="field-checklist-items">
        {checklistItems.map((item) => (
          <label className="field-checklist-item" key={item.id}>
            <input
              data-testid="field-checklist-item"
              checked={checked.has(item.id)}
              disabled={queued || pending}
              onChange={event=>setChecked(before=>{const next=new Set(before);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next;})}
              name="checklistItemIds"
              type="checkbox"
              value={item.id}
            />
            <span>{localizedChecklistLabel(item.label, locale)}</span>
          </label>
        ))}
      </div>
      <label className="field">
        <span>{labels.note}</span>
        <textarea name="note" rows={3} disabled={queued || pending} value={note} onChange={event => setNote(event.target.value)} />
      </label>
      {message ? (
        <p className="form-error" data-testid="field-task-form-error" role="alert">
          {message}
        </p>
      ) : null}
      {queueMessage ? (
        <p
          className={queueStatus === "conflict" || queueStatus === "rejected" || queueStatus === "storageError" ? "form-error" : "form-status"}
          data-testid="field-task-sync-status"
          role={queueStatus === "conflict" || queueStatus === "rejected" || queueStatus === "storageError" ? "alert" : "status"}
        >
          {queueMessage}
        </p>
      ) : null}
      <button
        className="primary-button field-complete-button"
        data-testid="field-task-complete"
        disabled={pending || queued || progressPending || checkedCount!==checklistItems.length}
        type="submit"
      >
        {pending || queueStatus === "syncing" ? labels.completing : labels.complete}
      </button>
      <button className="secondary-button field-complete-button" type="submit" data-progress="true" formAction={progressAction} disabled={pending||queued||progressPending||offline}>{progressText('saveProgress')}</button>
      {offline && !queued ? <p>{fieldText("offlineProgress")}</p> : null}
      {progress.status==='saved'?<p role="status">{progressText('saved')}</p>:progress.status==='error'?<p role="alert">{progressText(`errors.${progress.message??'generic'}`)}</p>:null}
    </form>
  );
}

function fieldError(state: FormState, field: string): string | null {
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
  const whatsapp = useTranslations("Whatsapp");
  const management = useTranslations("ReservationManagement");
  const schema = useMemo(
    () =>
      z.object({
        amount: z.string().regex(/^(?:|(?:0|[1-9]\d*)(?:\.\d{1,2})?)$/u, labels.validation).optional(),
        currency: z.string().regex(/^(?:|[A-Z]{3})$/u, labels.validation).optional(),
        adultCount: z.coerce.number().min(0, labels.validation),
        checkIn: z.string().trim().min(1, labels.validation),
        checkOut: z.string().trim().min(1, labels.validation),
        childCount: z.coerce.number().min(0, labels.validation),
        externalId: z.string().optional(),
        guestEmail: z.string().trim().email(labels.validation).or(z.literal("")),
        guestPhone: optionalGuestPhoneSchema,
        guestPreferredLocale: z.enum(["en", "fr", "ar"]),
        guestName: z.string().trim().min(1, labels.validation),
        notes: z.string().optional(),
        propertyId: z.string().trim().min(1, labels.validation),
        source: z.enum(["MANUAL", "DIRECT", "AGENCY", "AIRBNB", "BOOKING", "VRBO"])
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      adultCount: 2,
      checkIn: "",
      checkOut: "",
      childCount: 0,
      externalId: "",
      guestEmail: "",
      guestPhone: "",
      guestPreferredLocale: "fr",
      guestName: "",
      notes: "",
      source: "MANUAL"
    }
  });
  const [state, formAction, pending] = useActionState(
    createManualReservationAction.bind(null, locale),
    initialReservationFormState
  );
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);
  const hasProperties = properties.length > 0;

  return (
    <form
      className="resource-form"
      action={formAction}
      data-testid="reservation-create-form"
      onSubmit={validateSubmit}
    >
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label className="field">
        <span>{labels.property}</span>
        <select
          data-testid="reservation-property"
          defaultValue={properties[0]?.id ?? ""}
          required
          disabled={!hasProperties}
          {...form.register("propertyId")}
        >
          {properties.map((property) => (
            <option key={property.id} label={`${property.name} - ${property.city}`} value={property.id}>
              {property.name} - {property.city}
            </option>
          ))}
        </select>
        {!hasProperties ? <p className="field-hint">{labels.noProperties}</p> : null}
        <ErrorText testId="reservation-property-error">
          {firstClientError(form.formState.errors.propertyId) ?? fieldError(state, "propertyId")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{labels.guestName}</span>
        <input data-testid="reservation-guest-name" required {...form.register("guestName")} />
        <ErrorText testId="reservation-guest-name-error">
          {firstClientError(form.formState.errors.guestName) ?? fieldError(state, "guestName")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{labels.guestEmail}</span>
        <input autoComplete="email" data-testid="reservation-guest-email" type="email" {...form.register("guestEmail")} />
        <ErrorText testId="reservation-guest-email-error">
          {firstClientError(form.formState.errors.guestEmail) ?? fieldError(state, "guestEmail")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{whatsapp("guestPhone")}</span>
        <input type="tel" autoComplete="tel" data-testid="reservation-guest-phone" aria-describedby="guest-phone-hint" {...form.register("guestPhone")} />
        <small id="guest-phone-hint">{whatsapp("phoneHint")}</small>
        {form.formState.errors.guestPhone || fieldError(state, "guestPhone") ? <span role="alert">{labels.validation}</span> : null}
      </label>
      <label className="field"><span>{whatsapp("language")}</span>
        <select data-testid="reservation-guest-locale" {...form.register("guestPreferredLocale")}>
          {(["en", "fr", "ar"] as const).map((language) => <option key={language} value={language}>{whatsapp(`languages.${language}`)}</option>)}
        </select>
      </label>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.source}</span>
          <select data-testid="reservation-source" required {...form.register("source")}>
            {Object.entries(labels.sources).map(([value, label]) => (
              <option key={value} label={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.externalId}</span>
          <input data-testid="reservation-external-id" {...form.register("externalId")} />
          <ErrorText testId="reservation-external-id-error">{fieldError(state, "externalId")}</ErrorText>
        </label>
      </div>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.checkIn}</span>
          <input data-testid="reservation-check-in" required type="date" {...form.register("checkIn")} />
          <ErrorText testId="reservation-check-in-error">
            {firstClientError(form.formState.errors.checkIn) ?? fieldError(state, "checkIn")}
          </ErrorText>
        </label>
        <label className="field">
          <span>{labels.checkOut}</span>
          <input data-testid="reservation-check-out" required type="date" {...form.register("checkOut")} />
          <ErrorText testId="reservation-check-out-error">
            {firstClientError(form.formState.errors.checkOut) ?? fieldError(state, "checkOut")}
          </ErrorText>
        </label>
      </div>
      <div className="form-grid two">
        <label className="field">
          <span>{labels.adultCount}</span>
          <input data-testid="reservation-adults" type="number" min={0} {...form.register("adultCount")} />
        </label>
        <label className="field">
          <span>{labels.childCount}</span>
          <input data-testid="reservation-children" type="number" min={0} {...form.register("childCount")} />
        </label>
      </div>
      <label className="field">
        <span>{labels.notes}</span>
        <textarea rows={3} {...form.register("notes")} />
      </label>
      <div className="form-grid two"><label className="field"><span>{management("amountOptional")}</span><input inputMode="decimal" {...form.register("amount")} /></label><label className="field"><span>{management("currency")}</span><input minLength={3} maxLength={3} {...form.register("currency")} /></label></div>
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
