"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { liveQuery } from "dexie";
import { useRouter } from "next/navigation";
import { fieldQueue, syncFieldQueue, type FieldQueueScope } from "./field-queue";
import { resolveFieldScope } from "./field-session";
import { prepareFieldPhoto } from "./prepare-field-photo";

type Snapshot = Awaited<ReturnType<ReturnType<typeof fieldQueue>["photoSnapshot"]>>;
export function FieldPhotoCapture({ scope, taskId }: { scope: FieldQueueScope; taskId: string }) {
  const t = useTranslations("FieldPhoto"), cache = useTranslations("FieldCache"), router = useRouter(), id = useId();
  const [file, setFile] = useState<File | null>(null), [note, setNote] = useState(""), [saving, setSaving] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [notice, setNotice] = useState<"invalid" | "storage" | "unsaved" | "saved" | "queued" | null>(null);
  const input = useRef<HTMLInputElement>(null), mounted = useRef(false), previous = useRef<Snapshot | null>(null);
  const prepared = useRef<{ file: File; note: string; value: Awaited<ReturnType<typeof prepareFieldPhoto>> } | null>(null);
  const dirty = Boolean(file || note), { organizationId, userId } = scope;
  useEffect(() => {
    mounted.current = true;
    let disposed = false, subscription: { unsubscribe(): void } | undefined;
    const queue = fieldQueue(), owner = { organizationId, userId };
    const unavailable = () => { setSnapshot(null); setFile(null); setNote(""); setNotice(null); prepared.current = null; if (input.current) input.current.value = ""; };
    void resolveFieldScope(queue, navigator.onLine, owner).then(verified => {
      if (disposed) return;
      if (!verified) { unavailable(); return; }
      subscription = liveQuery(() => queue.photoSnapshot(owner, taskId)).subscribe({ next: value => {
      const before = previous.current;
      if (before?.incarnation === value.incarnation && before.photos.some(row => !value.photos.some(current => current.manifest.localId === row.manifest.localId))) {
        setNotice("saved"); if (navigator.onLine) router.refresh();
      }
      previous.current = value; setSnapshot(value);
      }, error: unavailable });
    }).catch(() => { if (!disposed) unavailable(); });
    return () => { disposed = true; mounted.current = false; subscription?.unsubscribe(); };
  }, [organizationId, userId, taskId, router]);
  useEffect(() => {
    if (!dirty) return;
    const hasUnsavedPhoto = () => Boolean(document.querySelector('[data-field-photo-dirty="true"]'));
    const unload = (event: BeforeUnloadEvent) => { if (hasUnsavedPhoto()) { event.preventDefault(); event.returnValue = ""; } };
    const leave = (event: MouseEvent) => {
      if (!hasUnsavedPhoto() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target || link.closest('[data-testid="field-language"]') || new URL(link.href).href === location.href) return;
      event.preventDefault(); event.stopPropagation(); setNotice("unsaved");
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  async function save() {
    if (!file || !note.trim()) { setNotice("invalid"); return; }
    setSaving(true); setNotice(null);
    try {
      const queue = fieldQueue();
      if (!await resolveFieldScope(queue, navigator.onLine, scope)) throw new Error("FIELD_SESSION_CHANGED");
      const state = await queue.photoSnapshot(scope, taskId); if (!state.canEdit || !state.incarnation) throw new Error("FIELD_SESSION_CHANGED");
      if (prepared.current?.file !== file || prepared.current.note !== note) prepared.current = { file, note, value: await prepareFieldPhoto(file, taskId, note) };
      const photo = prepared.current.value;
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate().catch((): StorageEstimate => ({}));
        if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < photo.blob.size) throw new DOMException("Device storage unavailable", "QuotaExceededError");
      }
      await queue.enqueuePhoto(scope, photo.manifest, photo.blob, state.incarnation);
      if (!mounted.current) return;
      setFile(null); setNote(""); prepared.current = null; if (input.current) input.current.value = "";
      setNotice("queued"); if (navigator.onLine) void syncFieldQueue(queue, scope).catch(() => undefined);
    } catch (error) { if (mounted.current) setNotice(error && typeof error === "object" && "name" in error && error.name === "QuotaExceededError" ? "storage" : "invalid"); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <section className="field-photo" data-testid="field-photo">
    <h2>{t("title")}</h2>
    <div className="field-photo-form" data-field-photo-dirty={dirty ? "true" : undefined} aria-busy={saving}>
      <label htmlFor={`${id}-file`}>{t("choose")}</label><input ref={input} id={`${id}-file`} type="file" accept="image/jpeg,image/png" capture="environment"
        disabled={saving || !snapshot?.canEdit} onChange={event => { setFile(event.target.files?.[0] ?? null); prepared.current = null; setNotice(null); }} data-testid="field-photo-file" />
      <label htmlFor={`${id}-note`}>{t("note")}</label><textarea id={`${id}-note`} dir="auto" maxLength={1000} value={note} disabled={saving || !snapshot?.canEdit}
        onChange={event => setNote(event.target.value)} data-testid="field-photo-note" />
      {!snapshot?.canEdit ? <p>{cache("notPrepared")}</p> : null}
      <div className="form-actions"><button className="primary-button" type="button" onClick={() => { void save(); }} disabled={saving || !file || !note.trim() || !snapshot?.canEdit} data-testid="field-photo-save">{t(saving ? "saving" : "save")}</button>
        {dirty ? <button className="secondary-button" type="button" disabled={saving} onClick={() => { setFile(null); setNote(""); prepared.current = null; if (input.current) input.current.value = ""; setNotice(null); }}>{t("discard")}</button> : null}</div>
    </div>
    {notice ? <p role={notice === "storage" || notice === "invalid" ? "alert" : "status"} data-testid="field-photo-notice">{t(notice)}</p> : null}
    <div className="field-photo-queue">{snapshot?.photos.map(photo => {
      const bytes = photo.uploadedParts.reduce((total, index) => total + photo.manifest.parts[index].size, 0), percent = photo.ready ? 95 : Math.round(bytes * 90 / photo.manifest.size);
      return <article key={photo.manifest.localId} data-testid="field-photo-queued"><p dir="auto">{photo.manifest.note}</p>
        <progress max={100} value={percent} aria-label={t("progress")} /><p role="status">{t(photo.syncStatus === "pending" ? photo.uploadId && !photo.retryAt ? "uploading" : "queued" : "review")}</p>
      </article>;
    })}</div>
  </section>;
}
