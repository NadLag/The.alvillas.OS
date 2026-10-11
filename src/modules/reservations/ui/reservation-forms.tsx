"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
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
};

type QueuedFieldTaskCompletion = {
  schemaVersion: 1;
  localId: string;
  userId: string;
  deviceId: string;
  clientOpId: string;
  taskId: string;
  checklistItemIds: string[];
  note?: string;
  clientCreatedAt: string;
  operation: "field_task.complete";
  syncStatus: "pending" | "syncing" | "conflict" | "rejected";
};

type SyncResult = {
  results?: Array<{
    client_op_id: string;
    status: "APPLIED" | "DUPLICATE" | "CONFLICT" | "REJECTED";
  }>;
};

const fieldQueueKey = "alvillas.fieldTaskQueue.v1";
const fieldDeviceKey = "alvillas.fieldDeviceId.v1";

function localizedLabel(label: Record<string, string>, locale: string): string {
  return label[locale] ?? label.en ?? Object.values(label)[0] ?? "";
}

function readFieldQueue(): QueuedFieldTaskCompletion[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(fieldQueueKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (item): item is QueuedFieldTaskCompletion =>
        item !== null &&
        typeof item === "object" &&
        (item as QueuedFieldTaskCompletion).schemaVersion === 1 &&
        (item as QueuedFieldTaskCompletion).operation === "field_task.complete" &&
        typeof (item as QueuedFieldTaskCompletion).clientOpId === "string"
    );
  } catch {
    return [];
  }
}

function writeFieldQueue(queue: QueuedFieldTaskCompletion[]): void {
  window.localStorage.setItem(fieldQueueKey, JSON.stringify(queue));
}

function getFieldDeviceId(): string {
  const existing = window.localStorage.getItem(fieldDeviceKey);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(fieldDeviceKey, next);
  return next;
}

async function syncFieldQueue(currentTaskId: string): Promise<"idle" | "synced" | "conflict" | "rejected"> {
  const queue = readFieldQueue();
  const pending = queue.find(
    (item) =>
      item.taskId === currentTaskId &&
      (item.syncStatus === "pending" || item.syncStatus === "syncing")
  );

  if (!pending || !navigator.onLine) {
    return "idle";
  }

  writeFieldQueue(
    queue.map((item) =>
      item.clientOpId === pending.clientOpId ? { ...item, syncStatus: "syncing" } : item
    )
  );

  const response = await fetch("/api/sync/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_id: pending.deviceId,
      op_schema_version: 1,
      ops: [
        {
          client_op_id: pending.clientOpId,
          type: pending.operation,
          payload: {
            taskId: pending.taskId,
            checklistItemIds: pending.checklistItemIds,
            note: pending.note
          },
          client_created_at: pending.clientCreatedAt
        }
      ]
    })
  });

  if (!response.ok) {
    writeFieldQueue(
      readFieldQueue().map((item) =>
        item.clientOpId === pending.clientOpId ? { ...item, syncStatus: "pending" } : item
      )
    );
    return "idle";
  }

  const result = (await response.json()) as SyncResult;
  const opResult = result.results?.find((item) => item.client_op_id === pending.clientOpId);

  if (opResult?.status === "APPLIED" || opResult?.status === "DUPLICATE") {
    writeFieldQueue(readFieldQueue().filter((item) => item.clientOpId !== pending.clientOpId));
    return "synced";
  }

  if (opResult?.status === "CONFLICT") {
    writeFieldQueue(
      readFieldQueue().map((item) =>
        item.clientOpId === pending.clientOpId ? { ...item, syncStatus: "conflict" } : item
      )
    );
    return "conflict";
  }

  writeFieldQueue(
    readFieldQueue().map((item) =>
      item.clientOpId === pending.clientOpId ? { ...item, syncStatus: "rejected" } : item
    )
  );
  return "rejected";
}

export function FieldTaskCompletionForm({
  locale,
  taskId,
  idempotencyKey,
  userId,
  checklistItems,
  labels
}: {
  locale: string;
  taskId: string;
  idempotencyKey: string;
  userId: string;
  checklistItems: ChecklistItemOption[];
  labels: FieldTaskLabels;
}) {
  const [state, formAction, pending] = useActionState(
    completeFieldTaskAction.bind(null, locale),
    initialFieldTaskFormState
  );
  const [queueStatus, setQueueStatus] = useState<
    "idle" | "queued" | "syncing" | "synced" | "conflict" | "rejected"
  >("idle");
  const message = messageForState(state, labels);
  const queued = queueStatus === "queued" || queueStatus === "syncing";

  useEffect(() => {
    let cancelled = false;

    async function sync(): Promise<void> {
      if (!navigator.onLine) {
        return;
      }

      const result = await syncFieldQueue(taskId);
      if (cancelled || result === "idle") {
        return;
      }

      setQueueStatus(result);
      if (result === "synced") {
        window.location.assign(`/${locale}/app/field`);
      }
    }

    const handleSync = () => {
      setQueueStatus((current) => (current === "queued" ? "syncing" : current));
      void sync();
    };

    void sync();
    window.addEventListener("online", handleSync);
    window.addEventListener("focus", handleSync);

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleSync);
      window.removeEventListener("focus", handleSync);
    };
  }, [locale, taskId]);

  function queueCompletion(formData: FormData): void {
    const checklistItemIds = formData.getAll("checklistItemIds").map(String);
    const noteValue = formData.get("note");
    const note = typeof noteValue === "string" ? noteValue.trim() : "";

    if (checklistItemIds.length !== checklistItems.length) {
      setQueueStatus("conflict");
      return;
    }

    const deviceId = getFieldDeviceId();
    const queue = readFieldQueue();
    const item: QueuedFieldTaskCompletion = {
      schemaVersion: 1,
      localId: crypto.randomUUID(),
      userId,
      deviceId,
      clientOpId: idempotencyKey,
      taskId,
      checklistItemIds,
      note: note || undefined,
      clientCreatedAt: new Date().toISOString(),
      operation: "field_task.complete",
      syncStatus: "pending"
    };

    writeFieldQueue([
      ...queue.filter((queuedItem) => queuedItem.clientOpId !== idempotencyKey),
      item
    ]);
    setQueueStatus("queued");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    if (navigator.onLine) {
      return;
    }

    event.preventDefault();
    queueCompletion(new FormData(event.currentTarget));
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
              : null;

  return (
    <form
      className="field-checklist"
      action={formAction}
      data-testid="field-task-complete-form"
      onSubmit={handleSubmit}
    >
      <input name="taskId" type="hidden" value={taskId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
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
      {queueMessage ? (
        <p
          className={queueStatus === "conflict" || queueStatus === "rejected" ? "form-error" : "form-status"}
          data-testid="field-task-sync-status"
          role={queueStatus === "conflict" || queueStatus === "rejected" ? "alert" : "status"}
        >
          {queueMessage}
        </p>
      ) : null}
      <button
        className="primary-button field-complete-button"
        data-testid="field-task-complete"
        disabled={pending || queued}
        type="submit"
      >
        {pending || queueStatus === "syncing" ? labels.completing : labels.complete}
      </button>
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
          <span>{labels.source}</span>
          <select data-testid="reservation-source" name="source" required defaultValue="MANUAL">
            {Object.entries(labels.sources).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.externalId}</span>
          <input data-testid="reservation-external-id" name="externalId" />
          <ErrorText testId="reservation-external-id-error">{fieldError(state, "externalId")}</ErrorText>
        </label>
      </div>
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
