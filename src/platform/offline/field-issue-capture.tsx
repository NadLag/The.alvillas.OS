"use client";

import { useEffect, useId, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { fieldQueue, syncFieldQueue, type FieldQueueScope } from "./field-queue";
import type { FieldIssueOperation } from "./field-queue-store";
import { resolveFieldScope } from "./field-session";
import { prepareFieldPhoto } from "./prepare-field-photo";
import { isStorageQuotaError } from "./storage-errors";
import { taskPriorities } from "@/modules/reservations/domain/operation-task";

type Snapshot = Awaited<ReturnType<ReturnType<typeof fieldQueue>["issueSnapshot"]>>;
export function FieldIssueCapture({ scope, taskId }: { scope: FieldQueueScope; taskId: string }) {
  const t = useTranslations("FieldIssue"), manage = useTranslations("Operations.manage"), router = useRouter(), id = useId();
  const [title, setTitle] = useState(""), [description, setDescription] = useState(""), [severity, setSeverity] = useState<(typeof taskPriorities)[number]>("NORMAL");
  const [file, setFile] = useState<File | null>(null), [saving, setSaving] = useState(false), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<"queued" | "saved" | "invalid" | "storage" | "unsaved" | null>(null);
  const input = useRef<HTMLInputElement>(null), mounted = useRef(false), previous = useRef<Snapshot | null>(null);
  const prepared = useRef<{ signature: string; file: File | null; operation: FieldIssueOperation; photo?: Awaited<ReturnType<typeof prepareFieldPhoto>> } | null>(null);
  const { organizationId, userId } = scope, dirty = Boolean(title || description || file || severity !== "NORMAL");
  useEffect(() => {
    mounted.current = true;
    let disposed = false, subscription: { unsubscribe(): void } | undefined;
    const queue = fieldQueue(), owner = { organizationId, userId };
    const unavailable = () => { setSnapshot(null); setTitle(""); setDescription(""); setFile(null); setSeverity("NORMAL"); setNotice(null); prepared.current = null; if (input.current) input.current.value = ""; };
    void resolveFieldScope(queue, navigator.onLine, owner).then(verified => {
      if (disposed) return;
      if (!verified) { unavailable(); return; }
      subscription = liveQuery(() => queue.issueSnapshot(owner, taskId)).subscribe({ next: value => {
        const before = previous.current;
        if (before?.incarnation === value.incarnation && before.issues.some(row => !value.issues.some(current => current.localId === row.localId))) {
          setNotice("saved"); if (navigator.onLine) router.refresh();
        }
        previous.current = value; setSnapshot(value);
      }, error: unavailable });
    }).catch(() => { if (!disposed) unavailable(); });
    return () => { disposed = true; mounted.current = false; subscription?.unsubscribe(); };
  }, [organizationId, userId, taskId, router]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leave = (event: MouseEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target || link.closest('[data-testid="field-language"]') || new URL(link.href).href === location.href) return;
      event.preventDefault(); event.stopPropagation(); setNotice("unsaved");
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  function discard() { setTitle(""); setDescription(""); setSeverity("NORMAL"); setFile(null); prepared.current = null; if (input.current) input.current.value = ""; }
  async function save() {
    setSaving(true); setNotice(null);
    try {
      const queue = fieldQueue();
      if (!await resolveFieldScope(queue, navigator.onLine, scope)) throw new Error("FIELD_SESSION_CHANGED");
      const state = await queue.issueSnapshot(scope, taskId);
      if (!state.canReport || !state.incarnation || (file && !state.canAttach)) throw new Error("FIELD_ISSUE_UNAVAILABLE");
      const signature = JSON.stringify({ taskId, title, description, severity });
      if (prepared.current?.signature !== signature || prepared.current.file !== file) {
        const photo = file ? await prepareFieldPhoto(file, taskId, description) : undefined;
        prepared.current = { signature, file, photo, operation: { type: "field_task.issue.report", client_op_id: crypto.randomUUID(),
          client_created_at: new Date().toISOString(), payload: { taskId, title, description, severity, ...(photo ? { photoClientOpId: photo.manifest.localId } : {}) } } };
      }
      await queue.enqueueIssue(scope, prepared.current.operation, state.incarnation, prepared.current.photo);
      if (!mounted.current) return;
      discard(); setNotice("queued"); if (navigator.onLine) void syncFieldQueue(queue, scope).catch(() => undefined);
    } catch (error) { if (mounted.current) setNotice(isStorageQuotaError(error) ? "storage" : "invalid"); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <section className="field-photo" data-testid="field-issue">
    <h2>{t("title")}</h2>
    <div className="field-photo-form" data-field-issue-dirty={dirty ? "true" : undefined} aria-busy={saving}>
      <label htmlFor={`${id}-title`}>{manage("issueTitle")}</label><input id={`${id}-title`} value={title} dir="auto" maxLength={240} disabled={saving || !snapshot?.canReport} onChange={event => setTitle(event.target.value)} data-testid="field-issue-title" />
      <label htmlFor={`${id}-description`}>{t("description")}</label><textarea id={`${id}-description`} value={description} dir="auto" maxLength={1000} disabled={saving || !snapshot?.canReport} onChange={event => setDescription(event.target.value)} data-testid="field-issue-description" />
      <label htmlFor={`${id}-severity`}>{manage("priority")}</label><select id={`${id}-severity`} value={severity} disabled={saving || !snapshot?.canReport} onChange={event => setSeverity(event.target.value as (typeof taskPriorities)[number])} data-testid="field-issue-severity">
        {taskPriorities.map(value => <option key={value} value={value}>{manage(`priorities.${value}`)}</option>)}
      </select>
      {snapshot?.canAttach ? <><label htmlFor={`${id}-file`}>{t("photo")}</label><input ref={input} id={`${id}-file`} type="file" accept="image/jpeg,image/png" capture="environment" disabled={saving || !snapshot.canReport}
        onChange={event => { setFile(event.target.files?.[0] ?? null); prepared.current = null; }} data-testid="field-issue-file" /></> : null}
      {!snapshot ? <p role="status">{t("loading")}</p> : !snapshot.canReport ? <p>{t("unavailable")}</p> : null}
      <div className="form-actions"><button className="primary-button" type="button" onClick={() => { void save(); }} disabled={saving || !title.trim() || description.trim().length < 6 || !snapshot?.canReport} data-testid="field-issue-save">{t(saving ? "saving" : "save")}</button>
        {dirty ? <button className="secondary-button" type="button" disabled={saving} onClick={() => { discard(); setNotice(null); }}>{t("discard")}</button> : null}</div>
    </div>
    {notice ? <p role={notice === "invalid" || notice === "storage" ? "alert" : "status"} data-testid="field-issue-notice">{t(notice)}</p> : null}
    <div className="field-photo-queue">{snapshot?.issues.map(entry => <article key={entry.localId} data-testid="field-issue-queued"><strong dir="auto">{entry.operation.payload.title}</strong><p dir="auto">{entry.operation.payload.description}</p>
      <p>{manage(`priorities.${entry.operation.payload.severity}`)}</p><p role="status">{t(entry.syncStatus === "pending" ? "queued" : "review")}</p></article>)}</div>
  </section>;
}
