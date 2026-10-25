"use client";

import { useEffect, useId, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { countedStockQuantitySchema, stockQuantitySchema } from "@/modules/inventory/domain/stocktake";
import { fieldStocktakePayloadSchema } from "@/platform/inventory/field-stocktake";
import { fieldQueue } from "./field-queue";
import { fieldLinenBaseMatches, type FieldLinenDraftInput, type FieldQueueScope } from "./field-queue-store";
import { resolveFieldScope } from "./field-session";

type Snapshot = Awaited<ReturnType<ReturnType<typeof fieldQueue>["linenSnapshot"]>>;
function initialValue(snapshot: Snapshot, taskId: string, itemKey: string): FieldLinenDraftInput | null {
  const linen = snapshot.task?.linen, item = linen?.items.find(item => item.key === itemKey);
  if (!linen?.catalog || !item) return null;
  return { taskId, itemKey, expectedQuantity: item.quantity, expectedRevision: item.revision, countedQuantity: item.quantity.startsWith("-") ? "0" : item.quantity,
    unit: item.unit, catalogRuleId: linen.catalog.id, catalogVersion: linen.catalog.version, note: "", clientOpId: crypto.randomUUID() };
}
function normalizeDigits(value: string) {
  const digits = value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)));
  return /^\d+$/u.test(digits) ? digits.replace(/^0+(?=\d)/u, "") : digits;
}

export function FieldLinen({ scope, taskId, locale }: { scope: FieldQueueScope; taskId: string; locale: AppLocale }) {
  const t = useTranslations("FieldLinen"), [items, setItems] = useState<string[] | null>(null), [storageError, setStorageError] = useState(false);
  const [blocked, setBlocked] = useState(false), { organizationId, userId } = scope;
  useEffect(() => {
    let disposed = false, subscription: { unsubscribe(): void } | undefined;
    const queue = fieldQueue(), owner = { organizationId, userId };
    void resolveFieldScope(queue, navigator.onLine, owner).then(verified => {
      if (disposed) return;
      if (!verified) { setItems([]); return; }
      subscription = liveQuery(() => queue.readCache(owner)).subscribe({ next: result => {
        const task = result.tasks.find(task => task.id === taskId);
        setItems(task?.linen?.items.map(item => item.key) ?? (result.state?.snapshotAt ? [] : null));
      }, error: () => { setItems([]); setStorageError(true); } });
    }).catch(() => { if (!disposed) { setItems([]); setStorageError(true); } });
    const dirty = () => Boolean(document.querySelector('[data-field-linen-dirty="true"]'));
    const unload = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
    const leave = (event: MouseEvent) => {
      if (!dirty() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target || link.closest('[data-testid="field-language"]') || new URL(link.href).href === location.href) return;
      event.preventDefault(); event.stopPropagation(); setBlocked(true);
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { disposed = true; subscription?.unsubscribe(); window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [organizationId, userId, taskId]);
  return <section className="field-linen" data-testid="field-linen">
    <h2>{t("title")}</h2><p>{t("guidance")}</p>
    {items === null ? <p role="status">{t("preparing")}</p> : items.length ? items.map(key => <LinenCount key={key} scope={scope} taskId={taskId} itemKey={key} locale={locale} />) : <p>{t("empty")}</p>}
    {storageError ? <p role="alert">{t("storageError")}</p> : null}
    {blocked ? <p role="status" data-testid="field-linen-unsaved">{t("unsaved")}</p> : null}
  </section>;
}

function LinenCount({ scope, taskId, itemKey, locale }: { scope: FieldQueueScope; taskId: string; itemKey: string; locale: AppLocale }) {
  const t = useTranslations("FieldLinen"), id = useId(), { organizationId, userId } = scope;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [value, setValue] = useState<FieldLinenDraftInput | null>(null);
  const valueRef = useRef<FieldLinenDraftInput | null>(null), wasQueued = useRef(false), mounted = useRef(false), writes = useRef<Promise<unknown>>(Promise.resolve());
  const [notice, setNotice] = useState<"savedDraft" | "queued" | "synced" | "storageError" | "invalid" | null>(null);
  const [busy, setBusy] = useState(false), [previousCount, setPreviousCount] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const queue = fieldQueue(), owner = { organizationId, userId };
    const subscription = liveQuery(() => queue.linenSnapshot(owner, taskId, itemKey)).subscribe({ next: next => {
      if (!mounted.current) return;
      setSnapshot(next);
      if (!next.task) { valueRef.current = null; setValue(null); return; }
      const original = next.entries.find(entry => entry.operation.client_op_id === valueRef.current?.clientOpId);
      if (wasQueued.current && !original && !next.draft) {
        const fresh = initialValue(next, taskId, itemKey); valueRef.current = fresh; setValue(fresh); setNotice("synced"); wasQueued.current = false;
      } else if (!valueRef.current) {
        const restored = next.draft ?? initialValue(next, taskId, itemKey); valueRef.current = restored; setValue(restored);
      } else if (next.draft && next.draft.clientOpId !== valueRef.current.clientOpId) {
        valueRef.current = next.draft; setValue(next.draft);
      }
      if (next.entries.some(entry => entry.operation.client_op_id === valueRef.current?.clientOpId && entry.syncStatus === "pending")) wasQueued.current = true;
    }, error: () => { if (mounted.current) { setSnapshot(null); setValue(null); valueRef.current = null; setNotice("storageError"); } } });
    return () => { mounted.current = false; subscription.unsubscribe(); };
  }, [organizationId, userId, taskId, itemKey]);
  const item = snapshot?.task?.linen?.items.find(item => item.key === itemKey), incarnation = snapshot?.state?.incarnation;
  const original = snapshot?.entries.find(entry => entry.operation.client_op_id === value?.clientOpId);
  const queued = original?.syncStatus === "pending", failed = Boolean(original && original.syncStatus !== "pending" && !original.resolvedByClientOpId);
  const changed = Boolean(value && snapshot?.task && !fieldLinenBaseMatches(value, snapshot.task));
  const reviewRequired = failed || changed, available = Boolean(item?.available && snapshot?.task?.canEdit), locked = !value || !available || queued || busy || reviewRequired;
  const validCount = value ? countedStockQuantitySchema.safeParse(value.countedQuantity).success : false;
  const dirty = Boolean(value && !queued && (value.note || value.countedQuantity !== value.expectedQuantity));
  function edit(update: Partial<Pick<FieldLinenDraftInput, "countedQuantity" | "note">>) {
    if (!value || !incarnation || locked) return;
    const next = { ...value, ...update }; valueRef.current = next; setValue(next); setNotice(null);
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const saved = await fieldQueue().saveLinenDraft({ organizationId, userId }, next, incarnation);
      if (mounted.current && valueRef.current?.clientOpId === next.clientOpId) setNotice(saved ? "savedDraft" : "storageError");
    }).catch(() => { if (mounted.current) setNotice("storageError"); });
  }
  async function save() {
    if (!value || !incarnation || locked) return;
    if (!fieldStocktakePayloadSchema.safeParse({ taskId, itemKey, expectedQuantity: value.expectedQuantity, expectedRevision: value.expectedRevision,
      countedQuantity: value.countedQuantity, unit: value.unit, catalogRuleId: value.catalogRuleId, catalogVersion: value.catalogVersion, note: value.note }).success) { setNotice("invalid"); return; }
    setBusy(true);
    try {
      await writes.current;
      if (!await fieldQueue().saveLinenDraft({ organizationId, userId }, value, incarnation)) throw new Error("FIELD_LINEN_UNAVAILABLE");
      wasQueued.current = true; await fieldQueue().enqueueLinen({ organizationId, userId }, value, incarnation);
      if (mounted.current && valueRef.current?.clientOpId === value.clientOpId && wasQueued.current) setNotice("queued"); window.dispatchEvent(new Event("focus"));
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function review() {
    if (!value || !snapshot || !incarnation || !available || queued || busy) return;
    const fresh = initialValue(snapshot, taskId, itemKey); if (!fresh) return;
    const next = { ...fresh, countedQuantity: "", note: value.note };
    setBusy(true);
    try {
      await writes.current;
      if (!await fieldQueue().saveLinenDraft({ organizationId, userId }, next, incarnation, value.clientOpId)) throw new Error("FIELD_LINEN_UNAVAILABLE");
      if (mounted.current) { setPreviousCount(value.countedQuantity); valueRef.current = next; setValue(next); wasQueued.current = false; setNotice(null); }
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!value || !item) return notice === "storageError" ? <p role="alert">{t("storageError")}</p> : null;
  const delta = validCount ? (BigInt(value.countedQuantity) - BigInt(value.expectedQuantity)).toString() : null;
  const name = localizedText(item.name, locale), format = (number: string) => stockQuantitySchema.safeParse(number).success
    ? new Intl.NumberFormat(locale).format(BigInt(number)) : number;
  return <article className="field-linen-item" data-testid="field-linen-item" data-item-key={itemKey} data-field-linen-dirty={dirty ? "true" : undefined}
    data-field-dirty={dirty ? "true" : undefined} aria-busy={busy}>
    <h3 dir="auto">{name}</h3>{item.unit ? <p className="muted" dir="auto">{item.unit}</p> : null}
    <p>{t("expected", { quantity: format(value.expectedQuantity) })}</p>
    <div className="field-linen-counter">
      <button type="button" className="secondary-button" aria-label={t("decrease", { item: name })} disabled={locked || !validCount || value.countedQuantity === "0"}
        data-testid="field-linen-decrease" onClick={() => edit({ countedQuantity: (BigInt(value.countedQuantity) - 1n).toString() })}><Minus aria-hidden="true" /></button>
      <label htmlFor={`${id}-count`} className="sr-only">{t("count", { item: name })}</label>
      <input id={`${id}-count`} type="text" inputMode="numeric" autoComplete="off" dir="ltr" value={value.countedQuantity} maxLength={20}
        aria-invalid={Boolean(value.countedQuantity && !validCount)} aria-describedby={`${id}-delta`} disabled={locked} data-testid="field-linen-count"
        onChange={event => edit({ countedQuantity: normalizeDigits(event.target.value) })}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
      <button type="button" className="secondary-button" aria-label={t("increase", { item: name })}
        disabled={locked || (value.countedQuantity !== "" && (!validCount || !countedStockQuantitySchema.safeParse((BigInt(value.countedQuantity) + 1n).toString()).success))}
        data-testid="field-linen-increase" onClick={() => edit({ countedQuantity: (BigInt(value.countedQuantity || "0") + 1n).toString() })}><Plus aria-hidden="true" /></button>
    </div>
    <p id={`${id}-delta`} role="status" data-testid="field-linen-delta">{delta === null ? t("enterCount") : t("variance", { quantity: format(delta) })}</p>
    {value.countedQuantity && !validCount ? <p role="alert">{t("invalid")}</p> : null}
    <label htmlFor={`${id}-note`}>{t("note")}</label><textarea id={`${id}-note`} dir="auto" rows={2} maxLength={1000} value={value.note} disabled={locked}
      data-testid="field-linen-note" onChange={event => edit({ note: event.target.value })} />
    {queued ? <p role="status" data-testid="field-linen-queued">{t("queued")}</p> : null}
    {reviewRequired ? <div className="field-linen-review" data-testid="field-linen-review-required"><p role="status">{t("reviewRequired")}</p>
      <dl><dt>{t("originalCount")}</dt><dd>{value.countedQuantity ? format(value.countedQuantity) : t("enterCount")}</dd><dt>{t("currentStock")}</dt><dd>{format(item.quantity)}</dd></dl>
      <button type="button" className="secondary-button" data-testid="field-linen-review" disabled={busy || queued || !available} onClick={() => { void review(); }}>{t("review")}</button></div> : null}
    {previousCount !== null ? <p>{t("previousCount", { quantity: previousCount ? format(previousCount) : t("enterCount") })}</p> : null}
    {!available ? <p role="status">{t("unavailable")}</p> : null}
    {notice && notice !== "queued" ? <p role={notice === "storageError" || notice === "invalid" ? "alert" : "status"} data-testid="field-linen-notice">{t(notice)}</p> : null}
    <button type="button" className="primary-button" data-testid="field-linen-save" disabled={locked || !validCount || !value.note.trim() || !incarnation}
      onClick={() => { void save(); }}>{t(busy ? "saving" : "save")}</button>
  </article>;
}
