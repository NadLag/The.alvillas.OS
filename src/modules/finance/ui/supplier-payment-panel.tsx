"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useTranslations } from "next-intl";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { getSupplierSettlementAction, postSupplierPaymentAction, voidSupplierPaymentAction } from "../application/supplier-payment-actions";
import type { getSupplierSettlement } from "../application/supplier-payment-service";
import type { supplierPaymentFormInput } from "../domain/supplier-payment";
import type { z } from "zod";

type Statement = Awaited<ReturnType<typeof getSupplierSettlement>>;
type Payment = z.infer<typeof supplierPaymentFormInput>;
type Failure = "forbidden" | "conflict" | "validation" | "policy" | "closed" | "clock" | "error";
type Occurrence = "reject" | "earlier" | "later";
const subscribe = (callback: () => void) => { window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; };
const clientOnline = () => navigator.onLine, serverOnline = () => true;
const canonicalAmount = (value: string) => normalizeAmountInput(value.trim());
const formText = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };

export function SupplierPaymentPanel({ invoiceId, locale, onChanged }: { invoiceId: string; locale: string; onChanged?: () => void }) {
  const t = useTranslations("SupplierInvoices.payment"), prefix = useId(), online = useSyncExternalStore(subscribe, clientOnline, serverOnline);
  const [data, setData] = useState<Statement | null>(null), [error, setError] = useState<Failure | null>(null), [busy, startTransition] = useTransition();
  const [amount, setAmount] = useState(""), [paidLocal, setPaidLocal] = useState(""), [occurrence, setOccurrence] = useState<Occurrence>("reject");
  const [fundingId, setFundingId] = useState(""), [fundingQuery, setFundingQuery] = useState(""), [reviewed, setReviewed] = useState(false);
  const [uncertain, setUncertain] = useState<Payment | null>(null), [uncertainVoid, setUncertainVoid] = useState<{ id: string; paymentId: string; reason: string } | null>(null);
  const generation = useRef(0), nonce = useRef(crypto.randomUUID()), paymentForm = useRef<HTMLFormElement>(null);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const failed = useCallback((code: Failure) => { if (code === "forbidden") { generation.current++; setData(null); setUncertain(null); setUncertainVoid(null); setFundingId(""); } setError(code); }, []);
  const load = useCallback(async (query: Parameters<typeof getSupplierSettlementAction>[0], initialize = false) => {
    const current = ++generation.current;
    try {
      const result = await getSupplierSettlementAction(query);
      if (current !== generation.current) return;
      if (!result.ok) { setReviewed(false); failed(result.code); return; }
      setData(result.data); setError(null); setReviewed(true);
      if (initialize) { setAmount(result.data.outstanding.amount); setPaidLocal(result.data.preview.paidLocal); setOccurrence("reject"); setFundingId(""); setFundingQuery(""); }
    } catch { if (current === generation.current) { setReviewed(false); setError("error"); } }
  }, [failed]);
  useEffect(() => { startTransition(() => load({ id: invoiceId }, true)); return invalidate; }, [invoiceId, load, invalidate]);
  const query = (extra: Record<string, unknown> = {}) => ({ id: invoiceId, ...(/[1-9]/u.test(canonicalAmount(amount)) ? { amount: canonicalAmount(amount) } : {}), paidLocal, occurrence,
    ...(fundingId ? { fundingAccountId: fundingId } : {}), ...(fundingQuery ? { fundingQuery } : {}), ...extra });
  const post = async (input: Payment) => {
    generation.current++; setError(null);
    try {
      const result = await postSupplierPaymentAction(input);
      if (!result.ok) { if (result.code === "error") setUncertain(input); else { setUncertain(null); setReviewed(false); } failed(result.code); return; }
      setUncertain(null); nonce.current = crypto.randomUUID(); paymentForm.current?.reset(); await load({ id: invoiceId }, true); onChanged?.();
    } catch { setUncertain(input); setError("error"); }
  };
  const reverse = async (input: { id: string; paymentId: string; reason: string }) => {
    generation.current++; setError(null);
    try {
      const result = await voidSupplierPaymentAction(input);
      if (!result.ok) { setUncertainVoid(result.code === "error" ? input : null); failed(result.code); return; }
      setUncertainVoid(null); await load({ id: invoiceId }, true); onChanged?.();
    } catch { setUncertainVoid(input); setError("error"); }
  };
  const frozen = busy || !online || Boolean(uncertain || uncertainVoid);
  const displayMoney = (money: { amount: string; currency: string }) => formatCurrencyAmount(safeLocale(locale), money.amount, money.currency);
  const displayDate = (value: string) => formatDateTime(safeLocale(locale), new Date(value), { timeZone: data?.timezone ?? "UTC" });
  return <section className="resource-form" data-testid="supplier-payment" aria-busy={busy} aria-labelledby={`${prefix}-title`}>
    <h3 id={`${prefix}-title`}>{t("title")}</h3>
    {data ? <>
      <p>{t("description")}</p>
      <p role="status" data-testid="supplier-payment-outstanding">{t("outstanding")}: {displayMoney(data.outstanding)}</p>
      {data.claimReversed ? <p>{t("claimReversed")}</p> : null}
      {data.canPreparePayment || uncertain ? <form ref={paymentForm} data-testid="supplier-payment-form" onSubmit={event => {
        event.preventDefault(); if (frozen || !reviewed || !data.canPay || !data.preview.calendarRuleId || !data.preview.calendarRuleVersion) return;
        const form = new FormData(event.currentTarget);
        const input: Payment = { id: invoiceId, expectedVersion: data.version, idempotencyKey: nonce.current,
          amount: canonicalAmount(amount), currency: data.outstanding.currency, fundingAccountId: fundingId,
          paidAt: data.preview.paidAt, paidLocal, occurrence, calendarRuleId: data.preview.calendarRuleId, calendarRuleVersion: data.preview.calendarRuleVersion,
          currentPeriod: data.preview.closed && form.get("currentPeriod") === "on", reference: formText(form, "reference") || null, reason: formText(form, "reason") };
        startTransition(() => post(input));
      }}>
        <label className="field" htmlFor={`${prefix}-amount`}><span>{t("amount", { currency: data.outstanding.currency })}</span>
          <input id={`${prefix}-amount`} data-testid="supplier-payment-amount" inputMode="decimal" value={amount} required disabled={frozen} onChange={event => { setAmount(event.target.value); setReviewed(false); }} /></label>
        <label className="field" htmlFor={`${prefix}-date`}><span>{t("paidLocal", { timezone: data.timezone })}</span>
          <input id={`${prefix}-date`} data-testid="supplier-payment-date" type="datetime-local" step="1" value={paidLocal} required disabled={frozen} onChange={event => { setPaidLocal(event.target.value); setReviewed(false); }} /></label>
        <label className="field" htmlFor={`${prefix}-occurrence`}><span>{t("occurrence")}</span>
          <select id={`${prefix}-occurrence`} data-testid="supplier-payment-occurrence" value={occurrence} disabled={frozen} onChange={event => { setOccurrence(event.target.value as Occurrence); setReviewed(false); }}>
            <option value="reject">{t("occurrences.reject")}</option><option value="earlier">{t("occurrences.earlier")}</option><option value="later">{t("occurrences.later")}</option>
          </select></label>
        <button className="secondary-button" type="button" data-testid="supplier-payment-preview" disabled={frozen} onClick={() => startTransition(() => load(query()))}>{t("review")}</button>
        {reviewed && data.preview.closed ? <label className="checkbox-field"><input type="checkbox" name="currentPeriod" data-testid="supplier-payment-adjustment" required disabled={frozen || !data.preview.canAdjust} /><span>{t("currentPeriod")}</span></label> : null}
        {reviewed && !data.canPay ? <p>{t("unavailable")}</p> : null}
        <label className="field" htmlFor={`${prefix}-search`}><span>{t("fundingSearch")}</span><input id={`${prefix}-search`} data-testid="supplier-payment-funding-query" value={fundingQuery} maxLength={120} disabled={frozen} onChange={event => setFundingQuery(event.target.value)} /></label>
        <button className="secondary-button" type="button" data-testid="supplier-payment-funding-search" disabled={frozen} onClick={() => startTransition(() => load(query()))}>{t("search")}</button>
        <label className="field" htmlFor={`${prefix}-funding`}><span>{t("funding")}</span><select id={`${prefix}-funding`} data-testid="supplier-payment-funding" value={fundingId} required disabled={frozen || !reviewed || !data.canPay} onChange={event => setFundingId(event.target.value)}>
          <option value="">{t("chooseFunding")}</option>{data.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        {data.fundingNext ? <button className="secondary-button" type="button" data-testid="supplier-payment-funding-more" disabled={frozen} onClick={() => startTransition(() => load(query({ fundingAfter: data.fundingNext })))}>{t("moreFunding")}</button> : null}
        <label className="field" htmlFor={`${prefix}-reference`}><span>{t("reference")}</span><input id={`${prefix}-reference`} data-testid="supplier-payment-reference" name="reference" maxLength={160} disabled={frozen} /></label>
        <label className="field" htmlFor={`${prefix}-reason`}><span>{t("reason")}</span><textarea id={`${prefix}-reason`} data-testid="supplier-payment-reason" name="reason" minLength={6} maxLength={500} required disabled={frozen} /></label>
        <button className="primary-button" type="submit" data-testid="supplier-payment-submit" disabled={frozen || !reviewed || !data.canPay || !fundingId}>{t(busy ? "saving" : "record")}</button>
      </form> : data.outstanding.amount !== "0" && data.outstanding.amount !== "0.00" && !data.claimReversed ? <p>{t("unavailable")}</p> : null}
      <h4>{t("history")}</h4>
      {data.payments.length ? <ol className="resource-list" data-testid="supplier-payment-history">{data.payments.map(payment => <li className="resource-card" key={payment.id} data-testid="supplier-payment-entry">
        <p>{displayMoney(payment.amount)} · {payment.fundingName}</p><p>{t("paidAt")}: {displayDate(payment.paidAt)}</p>
        <p>{t("postedAt")}: {displayDate(payment.occurredAt)}</p>{payment.reference ? <p>{t("reference")}: {payment.reference}</p> : null}<p>{payment.reason}</p>
        {payment.reversed ? <span className="status-badge">{t("reversed")}</span> : payment.canVoid ? <form onSubmit={event => {
          event.preventDefault(); if (frozen) return; const form = new FormData(event.currentTarget);
          startTransition(() => reverse({ id: invoiceId, paymentId: payment.id, reason: formText(form, "reason") }));
        }}><label className="field" htmlFor={`${prefix}-${payment.id}-reason`}><span>{t("voidReason")}</span><textarea id={`${prefix}-${payment.id}-reason`} data-testid="supplier-payment-void-reason" name="reason" required minLength={6} maxLength={500} disabled={frozen} /></label>
          <button className="secondary-button" data-testid="supplier-payment-void" type="submit" disabled={frozen}>{t("void")}</button></form> : null}
      </li>)}</ol> : <p>{t("empty")}</p>}
      {data.next ? <button className="secondary-button" type="button" data-testid="supplier-payment-older" disabled={frozen} onClick={() => startTransition(() => load(query({ before: data.next })))}>{t("older")}</button> : null}
    </> : busy ? <p role="status">{t("loading")}</p> : null}
    {uncertain || uncertainVoid ? <><p role="status">{t("uncertain")}</p><button className="primary-button" type="button" data-testid="supplier-payment-retry" disabled={busy || !online} onClick={() => startTransition(() => uncertain ? post(uncertain) : uncertainVoid ? reverse(uncertainVoid) : Promise.resolve())}>{t("retry")}</button></> : null}
    {!online ? <p role="status">{t("offline")}</p> : null}
    {error ? <p role="alert" data-testid="supplier-payment-error">{t(`errors.${error}`)}</p> : null}
    <button className="secondary-button" type="button" data-testid="supplier-payment-refresh" disabled={frozen} onClick={() => startTransition(() => load({ id: invoiceId }, true))}>{t("refresh")}</button>
  </section>;
}
