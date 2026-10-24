"use client";

import { useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { fieldQueue } from "./field-queue";
import type { FieldProxyDraftInput, FieldQueueScope } from "./field-queue-store";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { resolveFieldScope } from "./field-session";

export function useFieldProxyDraft(scope: FieldQueueScope, initial: FieldProxyDraftInput) {
  const { organizationId, userId } = scope, taskId = initial.taskId;
  const [value, setValue] = useState(initial), [ready, setReady] = useState(false);
  const [incarnation, setIncarnation] = useState<string | null>(null), [task, setTask] = useState<FieldWorkSnapshot>();
  const [queued, setQueued] = useState(false), [failed, setFailed] = useState(false), [queueRequired, setQueueRequired] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const hasTask = Boolean(task);
  const restored = useRef(false), writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let disposed = false, subscription: { unsubscribe(): void } | undefined;
    const owner = { organizationId, userId }, queue = fieldQueue();
    void resolveFieldScope(queue, navigator.onLine, owner).then(verified => {
      if (disposed) return;
      if (!verified) { setSessionChanged(true); setReady(false); return; }
      subscription = liveQuery(() => queue.proxySnapshot(owner, taskId)).subscribe({ next: snapshot => {
        if (disposed) return;
        setTask(snapshot.task); setIncarnation(snapshot.state?.incarnation ?? null);
        const original = snapshot.entries.find(entry => entry.operation.client_op_id === (snapshot.draft?.clientOpId ?? initial.clientOpId));
        setQueued(original?.syncStatus === "pending");
        setFailed(Boolean(original && original.syncStatus !== "pending" && !original.resolvedByClientOpId));
        setQueueRequired(Boolean(snapshot.draft?.supersedesClientOpId));
        if (!restored.current) {
          restored.current = true;
          if (snapshot.draft) setValue(snapshot.draft);
          setReady(true);
        }
      }, error: (error: unknown) => { if (!disposed) {
        if (error instanceof Error && error.message === "FIELD_SESSION_CHANGED") { setSessionChanged(true); setReady(false); }
        else { setStorageError(true); setReady(true); }
        setIncarnation(null);
      } } });
    }).catch((error: unknown) => { if (!disposed) {
      if (error instanceof Error && error.message === "FIELD_SESSION_CHANGED") { setSessionChanged(true); setReady(false); }
      else { setStorageError(true); setReady(true); }
    } });
    return () => { disposed = true; subscription?.unsubscribe(); };
  }, [organizationId, userId, taskId, initial.clientOpId]);

  useEffect(() => {
    if (!ready || !incarnation || !hasTask || queued || failed) return;
    let disposed = false;
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const saved = await fieldQueue().saveProxyDraft({ organizationId, userId }, value, incarnation);
      if (!disposed) setStorageError(!saved);
    }).catch(() => { if (!disposed) setStorageError(true); });
    return () => { disposed = true; };
  }, [ready, incarnation, hasTask, queued, failed, organizationId, userId, value]);

  const changed = Boolean(task?.proxyValidation && (task.proxyValidation.expectedVersion !== value.expectedVersion ||
    task.proxyValidation.performedByPersonId !== value.performedByPersonId));
  async function review() {
    if (!incarnation || !task?.proxyValidation || queued) return false;
    await writes.current;
    const next = { taskId, clientOpId: crypto.randomUUID(), performedByPersonId: task.proxyValidation.performedByPersonId,
      expectedVersion: task.proxyValidation.expectedVersion, checklistItemIds: [], reason: value.reason };
    try {
      if (!await fieldQueue().reviewProxyDraft({ organizationId, userId }, next, value.clientOpId, incarnation)) throw new Error("FIELD_PROXY_UNAVAILABLE");
      setValue(next); setQueueRequired(failed || queueRequired); setFailed(false); setStorageError(false);
      return true;
    } catch { setStorageError(true); return false; }
  }
  async function enqueue() {
    if (!incarnation || !task || changed || failed) throw new Error("FIELD_PROXY_REVIEW_REQUIRED");
    await writes.current;
    if (!await fieldQueue().saveProxyDraft({ organizationId, userId }, value, incarnation)) throw new Error("FIELD_PROXY_UNAVAILABLE");
    const operation = await fieldQueue().enqueueProxy({ organizationId, userId }, value, incarnation);
    setQueued(operation.syncStatus === "pending");
    window.dispatchEvent(new Event("focus"));
  }
  return { value, setValue, ready, task, queued, failed, queueRequired, storageError, setStorageError, review, enqueue, sessionChanged,
    canQueue: Boolean(incarnation && task && !storageError), reviewRequired: changed || failed };
}
