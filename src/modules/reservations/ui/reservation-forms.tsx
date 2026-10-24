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
import { fieldQueue, syncFieldQueue } from "@/platform/offline/field-queue";
import { resolveFieldScope } from "@/platform/offline/field-session";
import { refreshFieldCache } from "@/platform/offline/field-pull";

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
  labels,
  mode = "connected",
  readOnly = false
}: {
  locale: string;
  taskId: string;
  idempotencyKey: string;
  userId: string;
  organizationId: string;
  checklistItems: ChecklistItemOption[];
  labels: FieldTaskLabels;
  mode?: "connected" | "cached";
  readOnly?: boolean;
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
  const [draftReady, setDraftReady] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [cacheRevision, setCacheRevision] = useState(0);
  const edited = useRef(false);
  const draftIncarnation = useRef<string | null>(null);
  const message = messageForState(state, labels);
  const queued = queueStatus === "queued" || queueStatus === "syncing";
  const checkedCount = checklistItems.filter(item => checked.has(item.id)).length;
  const counterId = `field-checklist-progress-${taskId}`;

  useEffect(() => {
    let cancelled = false;
    const scope = { organizationId, userId };
    const ready = (async () => {
      const queue = fieldQueue();
      if (!await resolveFieldScope(queue, navigator.onLine, scope)) throw new Error("FIELD_SESSION_CHANGED");
      draftIncarnation.current = (await queue.readCache(scope)).state?.incarnation ?? null;
      await queue.migrateLegacy(scope, localStorage);
      const current = (await queue.entries(scope)).find(item => item.operation.type === "field_task.complete" && item.operation.payload.taskId === taskId);
      if (current && current.operation.type === "field_task.complete" && !cancelled) {
        setQueueStatus(current.syncStatus === "pending" ? "queued" : current.syncStatus);
        setChecked(new Set(current.operation.payload.checklistItemIds));
        setNote(current.operation.payload.note ?? "");
      } else {
        const draft = await queue.readDraft(scope, taskId);
        if (draft && !cancelled && !edited.current) {
          setChecked(new Set(draft.checklistItemIds)); setNote(draft.note);
        }
      }
      if (!cancelled) setDraftReady(true);
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
        const result = await syncFieldQueue(queue, scope);
        if (cancelled || result === "idle") return;
        setQueueStatus(result);
      } catch {
        if (!cancelled) setQueueStatus("storageError");
      } finally { syncing.current = false; }
    }
    const handleSync = () => { if (!cancelled) { setOffline(!navigator.onLine); void sync(); } };
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
    };
  }, [locale, organizationId, userId, taskId]);

  useEffect(() => {
    const refreshed = () => setCacheRevision(value => value + 1);
    window.addEventListener("alvillas-field-cache-ready", refreshed);
    return () => window.removeEventListener("alvillas-field-cache-ready", refreshed);
  }, []);

  useEffect(() => {
    if (!draftReady || queued || readOnly || !draftIncarnation.current) return;
    const incarnation = draftIncarnation.current;
    const scope = { organizationId, userId }; let cancelled = false;
    void fieldQueue().saveDraft(scope, taskId, [...checked], note, incarnation)
      .then(saved => { if (!cancelled) setDraftSaved(saved); })
      .catch(() => { if (!cancelled) setQueueStatus("storageError"); });
    return () => { cancelled = true; };
  }, [checked, note, draftReady, queued, organizationId, userId, taskId, readOnly, cacheRevision]);

  useEffect(() => {
    if (mode !== "cached" || progress.status !== "saved") return;
    const scope = { organizationId, userId };
    void refreshFieldCache(fieldQueue(), scope)
      .then(() => window.dispatchEvent(new Event("alvillas-field-cache-ready")))
      .catch(() => { /* The saved server progress and local draft remain available for the next refresh. */ });
  }, [mode, progress, organizationId, userId]);

  async function queueCompletion(formData: FormData): Promise<void> {
    const checklistItemIds = formData.getAll("checklistItemIds").map(String);
    const noteValue = formData.get("note");
    const note = typeof noteValue === "string" ? noteValue.trim() : "";
    if (checklistItemIds.length !== checklistItems.length) { setQueueStatus("conflict"); return; }
    try {
      await fieldQueue().enqueue({ organizationId, userId }, { client_op_id: idempotencyKey,
        type: "field_task.complete", client_created_at: new Date().toISOString(),
        payload: { taskId, checklistItemIds, note: note || undefined } });
      setQueueStatus("queued");
      if (navigator.onLine) window.dispatchEvent(new Event("online"));
    } catch { setQueueStatus("storageError"); }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (readOnly) { event.preventDefault(); return; }
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-progress") === "true") {
      if (!navigator.onLine) event.preventDefault();
      return;
    }
    if (navigator.onLine && mode === "connected") return;
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
              disabled={queued || pending || readOnly}
              onChange={event=>{edited.current=true;setDraftSaved(false);setChecked(before=>{const next=new Set(before);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next;});}}
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
        <textarea name="note" rows={3} maxLength={1000} disabled={queued || pending || readOnly} value={note} onChange={event => { edited.current=true;setDraftSaved(false);setNote(event.target.value); }} />
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
        disabled={readOnly || pending || queued || progressPending || checkedCount!==checklistItems.length}
        type="submit"
      >
        {pending || queueStatus === "syncing" ? labels.completing : labels.complete}
      </button>
      <button className="secondary-button field-complete-button" type="submit" data-progress="true" formAction={progressAction} disabled={readOnly||pending||queued||progressPending||offline}>{progressText('saveProgress')}</button>
      {offline && !queued ? <p>{fieldText("offlineProgress")}</p> : null}
      {draftSaved && !queued ? <p aria-live="polite" data-testid="field-draft-saved">{fieldText("draftSaved")}</p> : null}
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
