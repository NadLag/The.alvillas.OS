"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useTranslations } from "next-intl";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { getSupplierInvoiceReversalStatusAction, requestSupplierInvoiceReversalAction } from "../application/supplier-invoice-reversal-actions";
import type { getSupplierInvoiceReversalStatus } from "../application/supplier-invoice-reversal-status";
import type { supplierInvoiceReversalInput } from "../domain/supplier-payment";
import type { z } from "zod";

type Status = Awaited<ReturnType<typeof getSupplierInvoiceReversalStatus>>;
type Intent = { input: z.infer<typeof supplierInvoiceReversalInput>; confirmed: true };
type Failure = "forbidden" | "conflict" | "validation" | "policy" | "closed" | "error";
const subscribe = (callback: () => void) => { window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; };
const clientOnline = () => navigator.onLine, serverOnline = () => true;

export function SupplierClaimReversalPanel({ invoiceId, locale, revision, onReversed }: { invoiceId: string; locale: string; revision: number; onReversed: () => void }) {
  const t = useTranslations("SupplierInvoices"), prefix = useId(), online = useSyncExternalStore(subscribe, clientOnline, serverOnline);
  const [data, setData] = useState<Status | null>(null), [error, setError] = useState<Failure | null>(null), [busy, startTransition] = useTransition();
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState<Intent | null>(null);
  const nonce = useRef(crypto.randomUUID()), generation = useRef(0), submitting = useRef(false), reading = useRef(false);
  const invalidate = useCallback(() => { generation.current++; reading.current = false; }, []);
  const failed = useCallback((code: Failure) => {
    if (code === "forbidden") { generation.current++; setData(null); setReason(""); setConfirmed(false); setUncertain(null); }
    setError(code);
  }, []);
  const load = useCallback(async (before?: string) => {
    const current = ++generation.current; reading.current = true;
    try {
      const result = await getSupplierInvoiceReversalStatusAction({ id: invoiceId, ...(before ? { before } : {}) });
      if (current !== generation.current) return;
      if (result.ok) { setData(result.data); setError(null); } else failed(result.code);
    } catch { if (current === generation.current) setError("error"); }
    finally { if (current === generation.current) reading.current = false; }
  }, [invoiceId, failed]);
  useEffect(() => { startTransition(() => load()); return invalidate; }, [load, invalidate]);
  useEffect(() => { if (revision && !uncertain && !submitting.current) startTransition(() => load()); }, [revision, uncertain, load]);
  useEffect(() => {
    if (!data?.pending || !online || uncertain) return;
    const timer = window.setInterval(() => { if (!submitting.current && !reading.current) startTransition(() => load()); }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.pending, online, uncertain, load]);
  useEffect(() => { if (data?.reversed) onReversed(); }, [data?.reversed, onReversed]);
  const submit = async (intent: Intent) => {
    if (submitting.current) return;
    submitting.current = true; const current = ++generation.current; reading.current = false; setError(null);
    try {
      const result = await requestSupplierInvoiceReversalAction(intent);
      if (current !== generation.current) return;
      if (!result.ok) { setUncertain(result.code === "error" ? intent : null); failed(result.code); return; }
      setUncertain(null); nonce.current = crypto.randomUUID(); setReason(""); setConfirmed(false); await load();
    } catch { if (current === generation.current) { setUncertain(intent); setError("error"); } }
    finally { submitting.current = false; }
  };
  const frozen = busy || !online || Boolean(uncertain);
  return <section className="resource-form" data-testid="supplier-claim-reversal" aria-busy={busy} aria-labelledby={`${prefix}-title`}>
    <h3 id={`${prefix}-title`}>{t("reversal.title")}</h3>
    {data ? <>
      <p>{t("reversal.description")}</p>
      <p role="status" data-testid="supplier-claim-reversal-state">{t(data.reversed ? "reversal.reversed" : data.pending ? "reversal.pending" : "reversal.active")}</p>
      <p>{formatCurrencyAmount(safeLocale(locale), data.amount.amount, data.amount.currency)} · {t("recognition.costs", { count: data.sourceCosts })}</p>
      {data.canRequest || uncertain ? <form className="form-grid" data-testid="supplier-claim-reversal-form" onSubmit={event => {
        event.preventDefault(); if (frozen || !confirmed || !data.canRequest || reason.trim().length < 6) return;
        const intent: Intent = { input: { id: invoiceId, expectedVersion: data.version, idempotencyKey: nonce.current, reason: reason.trim() }, confirmed: true };
        startTransition(() => submit(intent));
      }}>
        <label className="field" htmlFor={`${prefix}-reason`}><span>{t("reason")}</span><textarea id={`${prefix}-reason`} data-testid="supplier-claim-reversal-reason" value={reason} minLength={6} maxLength={500} required disabled={frozen} onChange={event => setReason(event.target.value)} /></label>
        <label className="checkbox-field"><input type="checkbox" data-testid="supplier-claim-reversal-confirm" required checked={confirmed} disabled={frozen} onChange={event => setConfirmed(event.target.checked)} /><span>{t("reversal.confirm")}</span></label>
        <div className="form-actions"><button className="secondary-button" type="submit" data-testid="supplier-claim-reversal-submit" disabled={frozen}>{t(busy ? "saving" : "reversal.request")}</button></div>
      </form> : !data.reversed && !data.pending ? <p>{t(data.paymentsActive ? "reversal.paymentsActive" : !data.postingOpen ? "reversal.closed" : "reversal.unavailable")}</p> : null}
      <h4>{t("reversal.history")}</h4>
      {data.history.length ? <ol className="resource-list" data-testid="supplier-claim-reversal-history">{data.history.map(request => <li className="resource-card" key={request.id}>
        <span className="status-badge">{t(`recognition.states.${request.state}`)}</span><p>{request.reason}</p>
        <p>{t("createdUtc")}: {formatDateTime(safeLocale(locale), new Date(request.requestedAt), { timeZone: "UTC" })}</p>
        {request.failureCode ? <p>{t(`recognition.failures.${request.failureCode}`)}</p> : null}
      </li>)}</ol> : <p>{t("recognition.empty")}</p>}
      {data.next ? <button className="secondary-button" type="button" data-testid="supplier-claim-reversal-older" disabled={frozen} onClick={() => startTransition(() => load(data.next ?? undefined))}>{t("recognition.older")}</button> : null}
    </> : !error ? <p role="status">{t("reversal.loading")}</p> : null}
    {uncertain ? <><p role="status">{t("reversal.uncertain")}</p><button className="primary-button" type="button" data-testid="supplier-claim-reversal-retry" disabled={busy || !online} onClick={() => startTransition(() => submit(uncertain))}>{t("payment.retry")}</button></> : null}
    {!online ? <p role="status">{t("recognition.offline")}</p> : null}
    {error ? <p role="alert" data-testid="supplier-claim-reversal-error">{t(error === "closed" ? "reversal.closed" : error)}</p> : null}
    <button className="secondary-button" type="button" data-testid="supplier-claim-reversal-refresh" disabled={frozen} onClick={() => startTransition(() => load())}>{t("recognition.refresh")}</button>
  </section>;
}
