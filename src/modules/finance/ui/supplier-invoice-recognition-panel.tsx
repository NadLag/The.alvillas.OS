"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useTranslations } from "next-intl";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { getSupplierInvoiceRecognitionStatusAction, requestSupplierInvoiceRecognitionAction } from "../application/supplier-invoice-actions";
import type { getSupplierInvoiceRecognitionStatus } from "../application/supplier-invoice-recognition-status";
import { SupplierPaymentPanel } from "./supplier-payment-panel";
import { SupplierClaimReversalPanel } from "./supplier-claim-reversal-panel";

type Status = Awaited<ReturnType<typeof getSupplierInvoiceRecognitionStatus>>;
type Failure = "forbidden" | "conflict" | "validation" | "policy" | "error";
const subscribe = (callback: () => void) => { window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; };
const clientOnline = () => navigator.onLine, serverOnline = () => true;

export function SupplierInvoiceRecognitionPanel({ initial, locale }: { initial: Status; locale: string }) {
  const t = useTranslations("SupplierInvoices"), prefix = useId(), online = useSyncExternalStore(subscribe, clientOnline, serverOnline);
  const [data, setData] = useState<Status | null>(initial), [error, setError] = useState<Failure | null>(null), [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [busy, startTransition] = useTransition();
  const [settlementVersion, setSettlementVersion] = useState(0);
  const [reversalVersion, setReversalVersion] = useState(0);
  const claimReversed = useCallback(() => setSettlementVersion(version => version + 1), []);
  const paymentChanged = useCallback(() => setReversalVersion(version => version + 1), []);
  const generation = useRef(0);
  const refresh = useCallback(async (before?: string) => {
    const current = ++generation.current;
    try {
      const result = await getSupplierInvoiceRecognitionStatusAction({ id: initial.id, ...(before ? { before } : {}) });
      if (current !== generation.current) return;
      if (result.ok) { setData(result.data); setError(null); }
      else { if (result.code === "forbidden") setData(null); setError(result.code); }
    } catch { if (current === generation.current) setError("error"); }
  }, [initial.id]);
  useEffect(() => {
    if (!data?.pending || !online) return;
    const timer = window.setInterval(() => { startTransition(() => refresh()); }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.pending, online, refresh]);
  return <section className="resource-form" data-testid="invoice-recognition" aria-busy={busy} aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`}>{t("recognition.title")}</h2>
    {data ? <>
      <p>{t("recognition.description")}</p>
      <p role="status" data-testid="invoice-recognition-state">{t(data.recognized ? "recognition.recorded" : data.pending ? "recognition.pending" : "recognition.notRecorded")}</p>
      {data.recognized ? <p data-testid="invoice-recognized-amount">{formatCurrencyAmount(safeLocale(locale), data.amount, data.currency)} · {t("recognition.costs", { count: data.sourceCosts })}</p> : null}
      {data.recognizedAt ? <p>{t("createdUtc")}: {formatDateTime(safeLocale(locale), new Date(data.recognizedAt), { timeZone: "UTC" })}</p> : null}
      {data.canRequest ? <form data-testid="invoice-recognition-form" onSubmit={event => {
        event.preventDefault(); if (busy || !online) return;
        const form = new FormData(event.currentTarget); setError(null);
        startTransition(async () => {
          try {
            const result = await requestSupplierInvoiceRecognitionAction({ id: data.id, expectedVersion: data.version, idempotencyKey: nonce,
              reason: form.get("reason"), currentPeriod: data.currentPeriod });
            if (result.ok) { setNonce(crypto.randomUUID()); await refresh(); }
            else { if (result.code === "forbidden") { generation.current++; setData(null); } setError(result.code); }
          } catch { setError("error"); }
        });
      }}>
        {data.currentPeriod ? <label className="checkbox-field"><input data-testid="invoice-recognition-adjustment" type="checkbox" required disabled={busy || !online} /><span>{t("recognition.currentPeriod")}</span></label> : null}
        <label className="field" htmlFor={`${prefix}-reason`}><span>{t("reason")}</span><textarea id={`${prefix}-reason`} data-testid="invoice-recognition-reason" name="reason" minLength={6} maxLength={500} required disabled={busy || !online} /></label>
        <button className="primary-button" data-testid="invoice-recognize" type="submit" disabled={busy || !online}>{t(busy ? "saving" : "recognition.record")}</button>
      </form> : !data.recognized && !data.pending ? <p>{t("recognition.unavailable")}</p> : null}
      <h3>{t("recognition.history")}</h3>
      {data.history.length ? <ol className="resource-list" data-testid="invoice-recognition-history">{data.history.map(request => <li className="resource-card" key={request.id}>
        <span className="status-badge">{t(`recognition.states.${request.state}`)}</span><p>{request.reason}</p>
        <p>{t("createdUtc")}: {formatDateTime(safeLocale(locale), new Date(request.requestedAt), { timeZone: "UTC" })}</p>
        {request.failureCode ? <p>{t(`recognition.failures.${request.failureCode}`)}</p> : null}
      </li>)}</ol> : <p>{t("recognition.empty")}</p>}
      {data.next ? <button className="secondary-button" type="button" data-testid="invoice-recognition-older" disabled={busy || !online} onClick={() => startTransition(() => refresh(data.next ?? undefined))}>{t("recognition.older")}</button> : null}
      {data.recognized ? <>
        <SupplierPaymentPanel key={`${data.id}:${settlementVersion}`} invoiceId={data.id} locale={locale} onChanged={paymentChanged} />
        <SupplierClaimReversalPanel key={data.id} invoiceId={data.id} locale={locale} revision={reversalVersion} onReversed={claimReversed} />
      </> : null}
    </> : null}
    {!online ? <p role="status">{t("recognition.offline")}</p> : null}
    {error ? <p role="alert" data-testid="invoice-recognition-error">{t(error)}</p> : null}
    <button className="secondary-button" data-testid="invoice-recognition-refresh" type="button" disabled={busy || !online} onClick={() => startTransition(() => refresh())}>{t("recognition.refresh")}</button>
  </section>;
}
