"use client";

import { useEffect, useId, useRef, useState } from "react";
import { liveQuery } from "dexie";
import Decimal from "decimal.js";
import { useTranslations } from "next-intl";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { fieldCashPayloadSchema } from "@/platform/ledger/field-cash";
import { fieldQueue } from "./field-queue";
import type { FieldCashDraft, FieldQueueScope } from "./field-queue-store";

type Snapshot = Awaited<ReturnType<ReturnType<typeof fieldQueue>["cashSnapshot"]>>;
function fresh(snapshot: Snapshot, taskId: string, locale: AppLocale): FieldCashDraft | null {
  if (!snapshot.task?.cash?.canCollect) return null;
  return { taskId, amount: "", currency: snapshot.task.cash.baseCurrency, payer: snapshot.task.guestName ?? "",
    purpose: localizedTaskTitle(snapshot.task.title, locale).slice(0, 500), expectedRevision: snapshot.task.cash.revision,
    clientOpId: crypto.randomUUID(), clientCreatedAt: new Date().toISOString() };
}
function normalizeAmount(value: string) {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
    .replace(/[٫,]/gu, ".").replace(/^0+(?=\d)/u, "");
}
export function FieldCash({ scope, taskId, locale }: { scope: FieldQueueScope; taskId: string; locale: AppLocale }) {
  const t = useTranslations("FieldCash"), id = useId(), { organizationId, userId } = scope;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [value, setValue] = useState<FieldCashDraft | null>(null);
  const valueRef = useRef<FieldCashDraft | null>(null), wasQueued = useRef(false), mounted = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const [notice, setNotice] = useState<"savedDraft" | "queued" | "synced" | "storageError" | "invalid" | null>(null);
  const [busy, setBusy] = useState(false), [reason, setReason] = useState("");
  useEffect(() => {
    mounted.current = true;
    const subscription = liveQuery(() => fieldQueue().cashSnapshot({ organizationId, userId }, taskId)).subscribe({ next: next => {
      if (!mounted.current) return;
      setSnapshot(next);
      const pending = next.entries.some(entry => entry.syncStatus === "pending");
      if (wasQueued.current && !pending && !next.draft) {
        const initial = fresh(next, taskId, locale); valueRef.current = initial; setValue(initial); setNotice("synced"); wasQueued.current = false;
      } else if (!valueRef.current || next.draft && next.draft.clientOpId !== valueRef.current.clientOpId) {
        const initial = next.draft ?? fresh(next, taskId, locale); valueRef.current = initial; setValue(initial);
      }
      if (pending) wasQueued.current = true;
    }, error: () => { if (mounted.current) { setSnapshot(null); setValue(null); valueRef.current = null; setNotice("storageError"); } } });
    return () => { mounted.current = false; subscription.unsubscribe(); };
  }, [organizationId, userId, taskId, locale]);
  const cash = snapshot?.task?.cash, incarnation = snapshot?.state?.incarnation;
  const unresolved = snapshot?.entries.filter(entry => !entry.resolvedByClientOpId) ?? [];
  const queued = unresolved.some(entry => entry.syncStatus === "pending"), failed = unresolved.some(entry => entry.syncStatus !== "pending");
  const original = unresolved.find(entry => entry.operation.client_op_id === value?.clientOpId);
  const reviewRequired = Boolean(value && (original && original.syncStatus !== "pending" || value.expectedRevision !== cash?.revision));
  const available = Boolean(cash?.canCollect), locked = !value || !available || busy || queued || reviewRequired || Boolean(snapshot?.draft?.submittedDeviceId);
  const parsed = value ? fieldCashPayloadSchema.safeParse({ taskId, amount: value.amount, currency: value.currency, payer: value.payer, purpose: value.purpose, expectedRevision: value.expectedRevision }) : null;
  const currency = cash?.currencies.find(item => item.code === value?.currency);
  const valid = Boolean(parsed?.success && currency && new Decimal(parsed.data.amount).decimalPlaces() <= currency.minorUnit);
  const blocked = Boolean(snapshot?.draft && !snapshot.draft.submittedDeviceId || failed);
  useEffect(() => {
    if (!blocked) return;
    const unload = (event: BeforeUnloadEvent) => { if (!queued) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload); return () => window.removeEventListener("beforeunload", unload);
  }, [blocked, queued]);
  function edit(update: Partial<Pick<FieldCashDraft, "amount" | "currency" | "payer" | "purpose">>) {
    if (!value || !incarnation || locked) return;
    const next = { ...value, ...update }; valueRef.current = next; setValue(next); setNotice(null);
    writes.current = writes.current.catch(() => undefined).then(async () => {
      const saved = await fieldQueue().saveCashDraft({ organizationId, userId }, next, incarnation);
      if (mounted.current && valueRef.current?.clientOpId === next.clientOpId) setNotice(saved ? "savedDraft" : "storageError");
    }).catch(() => { if (mounted.current) setNotice("storageError"); });
  }
  async function save() {
    if (!value || !incarnation || locked || !valid) { setNotice("invalid"); return; }
    setBusy(true);
    try {
      await writes.current;
      if (!await fieldQueue().saveCashDraft(scope, value, incarnation)) throw new Error("FIELD_CASH_UNAVAILABLE");
      wasQueued.current = true; await fieldQueue().enqueueCash(scope, value, incarnation);
      if (mounted.current && wasQueued.current) setNotice("queued"); window.dispatchEvent(new Event("focus"));
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function review() {
    if (!snapshot || !value || !incarnation || !available || busy || queued) return;
    const initial = fresh(snapshot, taskId, locale); if (!initial) return;
    const next = { ...initial, payer: value.payer, purpose: value.purpose, currency: value.currency, supersedesClientOpId: value.clientOpId };
    setBusy(true);
    try {
      await writes.current;
      if (!await fieldQueue().saveCashDraft(scope, next, incarnation)) throw new Error("FIELD_CASH_UNAVAILABLE");
      valueRef.current = next; setValue(next); wasQueued.current = false; setNotice(null);
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function clear() {
    if (!value || busy || queued) return;
    setBusy(true);
    try {
      await writes.current;
      if (!await fieldQueue().clearCashDraft(scope, taskId, value.clientOpId)) throw new Error("FIELD_CASH_UNAVAILABLE");
      const initial = snapshot ? fresh(snapshot, taskId, locale) : null; valueRef.current = initial; setValue(initial); setNotice(null);
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  const originalPayload = original?.operation.type === "field_cash.collect" && original.syncStatus === "conflict" ? original.operation.payload : undefined;
  const matching = originalPayload ? cash?.receipts.find(receipt => receipt.currency === originalPayload.currency && new Decimal(receipt.amount).eq(originalPayload.amount) &&
    receipt.payer === originalPayload.payer && receipt.purpose === originalPayload.purpose) : undefined;
  async function confirm() {
    if (!matching || !original || !incarnation || busy || queued || reason.trim().length < 6) return;
    setBusy(true);
    try {
      await writes.current;
      wasQueued.current = true;
      await fieldQueue().confirmCash(scope, { taskId, originalDeviceId: original.deviceId, originalClientOpId: original.operation.client_op_id, receiptId: matching.id, reason }, incarnation, original.operation.client_op_id);
      setNotice("queued"); window.dispatchEvent(new Event("focus"));
    } catch { if (mounted.current) setNotice("storageError"); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!value && !notice) return null;
  return <section className="field-cash field-linen-item" data-testid="field-cash" aria-busy={busy}
    data-field-cash-dirty={blocked ? "true" : undefined} data-field-dirty={blocked ? "true" : undefined}
    onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <h2>{t("title")}</h2><p>{t("guidance")}</p>
    {value ? <>
      <label htmlFor={`${id}-amount`}>{t("amount")}</label><input id={`${id}-amount`} type="text" inputMode="decimal" dir="ltr" autoComplete="off"
        maxLength={19} value={value.amount} disabled={locked} data-testid="field-cash-amount" onChange={event => edit({ amount: normalizeAmount(event.target.value) })} />
      <label htmlFor={`${id}-currency`}>{t("currency")}</label><select id={`${id}-currency`} value={value.currency} disabled={locked} data-testid="field-cash-currency" onChange={event => edit({ currency: event.target.value })}>
        {cash?.currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}
      </select>
      <label htmlFor={`${id}-payer`}>{t("payer")}</label><input id={`${id}-payer`} dir="auto" maxLength={240} value={value.payer} disabled={locked} data-testid="field-cash-payer" onChange={event => edit({ payer: event.target.value })} />
      <label htmlFor={`${id}-purpose`}>{t("purpose")}</label><textarea id={`${id}-purpose`} dir="auto" rows={2} maxLength={500} value={value.purpose} disabled={locked} data-testid="field-cash-purpose" onChange={event => edit({ purpose: event.target.value })} />
      {queued ? <p role="status" data-testid="field-cash-queued">{t("queued")}</p> : null}
      {reviewRequired || failed ? <div className="field-linen-review" data-testid="field-cash-review-required"><p role="status">{t("reviewRequired")}</p>
        <button type="button" className="secondary-button" data-testid="field-cash-review" disabled={!available || queued || busy} onClick={() => { void review(); }}>{t("reviewAdditional")}</button>
        {matching ? <><p>{t("matchingReceipt", { receipt: matching.id })}</p><label htmlFor={`${id}-reason`}>{t("reviewReason")}</label>
          <textarea id={`${id}-reason`} maxLength={500} value={reason} disabled={busy || queued} data-testid="field-cash-review-reason" onChange={event => setReason(event.target.value)} />
          <button type="button" className="secondary-button" data-testid="field-cash-confirm-existing" disabled={busy || queued || reason.trim().length < 6} onClick={() => { void confirm(); }}>{t("confirmExisting")}</button></> : null}
      </div> : null}
      <button type="button" className="primary-button" data-testid="field-cash-save" disabled={locked || !valid || !incarnation} onClick={() => { void save(); }}>{t(busy ? "saving" : "save")}</button>
      {snapshot?.draft && !snapshot.draft.submittedDeviceId ? <button type="button" className="secondary-button" data-testid="field-cash-clear" disabled={busy || queued} onClick={() => { void clear(); }}>{t("clearDraft")}</button> : null}
    </> : null}
    {notice && notice !== "queued" ? <p role={notice === "storageError" || notice === "invalid" ? "alert" : "status"} data-testid="field-cash-notice">{t(notice)}</p> : null}
    {cash?.historyVisible ? <><h3>{t("recent")}</h3>{cash.receipts.length ? <ul className="field-cash-receipts">{cash.receipts.map(receipt => <li key={receipt.id} data-testid="field-cash-receipt">
      <strong>{formatCurrencyAmount(locale, receipt.amount, receipt.currency)}</strong><span dir="auto">{receipt.payer}</span><span dir="auto">{receipt.purpose}</span>
      <time dateTime={receipt.recordedAt}>{formatDateTime(locale, new Date(receipt.recordedAt))}</time>
    </li>)}</ul> : <p>{t("noReceipts")}</p>}</> : null}
  </section>;
}
