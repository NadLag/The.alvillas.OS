"use client";
import { useCallback, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { Money } from "@/platform/money/money";
import { externalPaymentFeeDraftInput, type externalPaymentReviewInput } from "../domain/external-payment-command";
import { externalCaptureCommandSchema, externalCaptureReceiptSchema, externalCaptureRecoverySchema, externalCaptureReviewSchema,
  externalAdmissionCommandSchema, externalAdmissionReceiptSchema, externalAdmissionRecoverySchema, externalAdmissionReviewSchema, acceptExternalCapture } from "../domain/external-payment-workspace";
import { useCompensationCommand, storeCompensationNonce } from "./use-compensation-command";
import { useCompensationRead } from "./use-compensation-read";
import { companyExpenseFormText as text } from "./company-expense-form-text";

export type ExternalPaymentDraft = z.infer<typeof externalPaymentReviewInput>;
type Captured = z.infer<typeof externalCaptureReceiptSchema>;
type Props = { locale: AppLocale; scope: string; draft: ExternalPaymentDraft | null; onInvalidate: () => void; onAdmitted: (depositId: string) => void };
const readPath = "/api/finance/external-payments/read", commandPath = "/api/finance/external-payments/command", recoveryPath = "/api/finance/external-payments/recover";
const recoveryInput = (key: string) => ({ key }), statusPath = (id: string) => "/api/finance/external-payments/status/" + id;
function captureBody(input: z.infer<typeof externalCaptureCommandSchema>) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "CAPTURE", input: { provider: input.provider, orderId: input.orderId, receipt: { ...input.receipt, idempotencyKey: input.idempotencyKey } } }) };
}
function admissionBody(input: z.infer<typeof externalAdmissionCommandSchema>) {
  const { idempotencyKey: ignored, ...original } = input; void ignored;
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "ADMIT", input: original }) };
}
const acceptAdmission = (receipt: z.infer<typeof externalAdmissionReceiptSchema>, _input: unknown, nonce: string | null) => receipt.idempotencyKey === nonce;

/** The shared command boundary persists only the scoped random nonce throughout both native phases. */
export function ExternalPaymentWorkspace(props: Props) {
  const { onAdmitted } = props;
  const [captured, setCaptured] = useState<Captured | null>(null), storageKey = "alvillas:external-payment:" + props.scope;
  const onCaptured = useCallback((receipt: Captured) => {
    if (receipt.admission) { onAdmitted(receipt.admission.depositId); return; }
    storeCompensationNonce(storageKey, receipt.idempotencyKey); setCaptured(receipt);
  }, [onAdmitted, storageKey]);
  return captured ? <AdmissionPhase {...props} captured={captured} storageKey={storageKey} /> : <CapturePhase {...props} storageKey={storageKey} onCaptured={onCaptured} />;
}

function CommandRecovery({ state, recover, retry }: { state: string; recover: () => void; retry: () => void }) {
  const t = useTranslations("ExternalPayments");
  return <><p role="status" data-testid="external-command-status">{t("command_" + state)}</p>
    {["uncertain", "recoveryUnavailable", "offline", "terminal"].includes(state) ? <button className="secondary-button" type="button" onClick={recover}>{t("recover")}</button> : null}
    {state === "uncertain" ? <button className="secondary-button" type="button" onClick={retry}>{t("retryExact")}</button> : null}</>;
}

function CapturePhase({ storageKey, onCaptured, ...props }: Props & { storageKey: string; onCaptured: (value: Captured) => void }) {
  const t = useTranslations("ExternalPayments"), [pending, setPending] = useState<Captured | null>(null), [reconciling, startReconciliation] = useTransition(), [error, setError] = useState<string | null>(null);
  const onPending = useCallback((receipt: Captured) => setPending(receipt), []);
  const command = useCompensationCommand({ storageKey, inputSchema: externalCaptureCommandSchema, receiptSchema: externalCaptureReceiptSchema, recoverySchema: externalCaptureRecoverySchema,
    requestPath: commandPath, recoveryPath, recoveryInput, statusPath, requestBody: captureBody, accept: acceptExternalCapture, onPending, onSuccess: onCaptured, onInvalidate: props.onInvalidate });
  if (!props.draft && command.state === "ready") return null;
  return <section className="resource-form" data-testid="external-payment-capture"><h2>{t("captureTitle")}</h2><p>{t("captureGuidance")}</p>
    <CommandRecovery state={command.state} recover={() => { void command.recover(); }} retry={() => { void command.send(); }} />
    {error ? <p role="alert">{t(error)}</p> : null}
    {pending && command.state === "pending" ? <button className="secondary-button" type="button" disabled={reconciling} data-testid="external-reconcile" onClick={() => startReconciliation(async () => {
      setError(null);
      try { const response = await fetch(commandPath, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "RECONCILE", input: { id: pending.id } }) });
        if (response.status === 401 || response.status === 403) { props.onInvalidate(); return; }
        if (!response.ok) throw Error(); externalCaptureReceiptSchema.parse(await response.json()); await command.recover();
      } catch { setError("unavailable"); }
    })}>{t("reconcile")}</button> : null}
    {props.draft && command.state === "ready" ? <CaptureReview draft={props.draft} locale={props.locale} onInvalidate={props.onInvalidate} send={input => { void command.send(input); }} /> : null}
  </section>;
}

function CaptureReview({ draft, locale, onInvalidate, send }: { draft: ExternalPaymentDraft; locale: AppLocale; onInvalidate: () => void; send: (input: Omit<z.infer<typeof externalCaptureCommandSchema>, "idempotencyKey">) => void }) {
  const t = useTranslations("ExternalPayments"), [confirmed, setConfirmed] = useState(false), [validation, setValidation] = useState(false),
    read = useCompensationRead(readPath, externalCaptureReviewSchema, onInvalidate, JSON.stringify({ operation: "REVIEW_CAPTURE", input: draft }));
  if (read.error) return <p role="alert">{t(read.error)}</p>; if (read.pending || !read.data) return <SkeletonBlock rows={3} />; const review = read.data;
  return <form className="resource-form" data-testid="external-capture-review" onSubmit={event => {
    event.preventDefault(); if (!confirmed) return;
    const result = externalCaptureCommandSchema.omit({ idempotencyKey: true }).safeParse({ ...draft, receipt: { ...draft.receipt, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason: text(new FormData(event.currentTarget).get("reason")) } });
    if (result.success) send(result.data); else setValidation(true);
  }}><dl className="compensation-evidence"><div><dt>{t("gross")}</dt><dd className="compensation-total">{formatCurrencyAmount(locale, review.amount.amount, review.amount.currency)}</dd></div>
    <div><dt>{t("merchant")}</dt><dd dir="auto">{review.account.name}</dd></div><div><dt>{t("order")}</dt><dd dir="ltr">{draft.orderId}</dd></div></dl>
    <p>{t("captureConfirmation")}</p><label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="external-capture-reason" /></label>
    <label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} data-testid="external-capture-confirm" /><span>{t("confirmCapture")}</span></label>
    {validation ? <p role="alert">{t("validation")}</p> : null}<button className="primary-button" type="submit" disabled={!confirmed} data-testid="external-capture-submit">{t("capture")}</button></form>;
}

function AdmissionPhase({ storageKey, captured, locale, onInvalidate, onAdmitted }: Props & { storageKey: string; captured: Captured }) {
  const t = useTranslations("ExternalPayments"), [confirmed, setConfirmed] = useState(false), [error, setError] = useState<string | null>(null), [preparing, startPreparation] = useTransition();
  const success = useCallback((receipt: z.infer<typeof externalAdmissionReceiptSchema>) => onAdmitted(receipt.depositId), [onAdmitted]);
  const command = useCompensationCommand({ storageKey, inputSchema: externalAdmissionCommandSchema, receiptSchema: externalAdmissionReceiptSchema, recoverySchema: externalAdmissionRecoverySchema,
    requestPath: commandPath, recoveryPath, recoveryInput, requestBody: admissionBody, accept: acceptAdmission, onSuccess: success, onInvalidate: onInvalidate });
  const read = useCompensationRead(readPath, externalAdmissionReviewSchema, onInvalidate, JSON.stringify({ operation: "REVIEW_ADMISSION", input: { id: captured.id } }));
  if (read.error) return <p role="alert">{t(read.error)}</p>; if (read.pending || !read.data) return <SkeletonBlock rows={4} />;
  const review = read.data, hasFee = Boolean(review.settlement && Money.of(review.settlement.fee.amount, review.settlement.fee.currency).amount.gt(0)), feeReady = !hasFee || Boolean(review.fee && ["APPROVED", "POSTED"].includes(review.fee.state)), ready = command.state === "ready" && Boolean(review.settlement) && feeReady;
  return <section className="resource-form" data-testid="external-payment-admission"><h2>{t("admissionTitle")}</h2><p>{t("admissionGuidance")}</p>
    <CommandRecovery state={command.state} recover={() => { void command.recover(); }} retry={() => { void command.send(); }} />
    <dl className="compensation-evidence"><div><dt>{t("gross")}</dt><dd>{formatCurrencyAmount(locale, review.amount.amount, review.amount.currency)}</dd></div>
      <div><dt>{t("merchant")}</dt><dd dir="auto">{review.account.name}</dd></div><div><dt>{t("capturedAt")}</dt><dd>{formatDateTime(locale, new Date(captured.capturedAt!), { timeZone: "UTC" })}</dd></div>
      {review.settlement ? <><div><dt>{t("fee")}</dt><dd>{formatCurrencyAmount(locale, review.settlement.fee.amount, review.settlement.fee.currency)}</dd></div><div><dt>{t("net")}</dt><dd>{formatCurrencyAmount(locale, review.settlement.net.amount, review.settlement.net.currency)}</dd></div></> : null}</dl>
    {!review.settlement ? <p role="status">{t("settlementUnavailable")}</p> : null}
    {hasFee && !review.fee ? <form className="resource-form" data-testid="external-fee-prepare" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget), input = externalPaymentFeeDraftInput.safeParse({ intentId: captured.id, category: text(form.get("category")), purpose: text(form.get("purpose")), reason: text(form.get("reason")) });
      if (!input.success) { setError("validation"); return; }
      startPreparation(async () => { setError(null); try { const response = await fetch(commandPath, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "PREPARE_FEE", input: input.data }) });
        if (response.status === 401 || response.status === 403) { onInvalidate(); return; } if (!response.ok) throw Error(); await read.refresh();
      } catch { setError("unavailable"); } });
    }}><h3>{t("prepareFee")}</h3><p>{t("feeGuidance")}</p><fieldset className="resource-form" disabled={preparing}><legend>{t("fee")}</legend>
      <label className="field"><span>{t("category")}</span><input name="category" dir="auto" required pattern="[a-z][a-z0-9_.-]{0,119}" maxLength={120} data-testid="external-fee-category" /></label>
      <label className="field"><span>{t("purpose")}</span><input name="purpose" dir="auto" required minLength={3} maxLength={1000} data-testid="external-fee-purpose" /></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="external-fee-reason" /></label><button className="secondary-button" type="submit" data-testid="external-fee-submit">{t("prepareFee")}</button></fieldset></form> : null}
    {review.fee ? <><p role="status">{t("feeState_" + review.fee.state)}</p><Link className="secondary-button" href={`/${locale}/app/expenses/${review.fee.id}`} data-testid="external-fee-link">{t("openFee")}</Link><button className="secondary-button" type="button" onClick={() => { void read.refresh(); }}>{t("refresh")}</button></> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
    <form className="resource-form" onSubmit={event => { event.preventDefault(); if (!ready || !confirmed) return;
      const reason = text(new FormData(event.currentTarget).get("reason")); void command.send({ intentId: captured.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint, reason,
        ...hasFee && review.fee ? { fee: { expenseId: review.fee.id, expectedVersion: review.fee.version, reason } } : {} });
    }}><fieldset className="resource-form" disabled={!ready}><legend>{t("admissionTitle")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="external-admission-reason" /></label>
      <label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} data-testid="external-admission-confirm" /><span>{t("confirmAdmission")}</span></label></fieldset>
      <button className="primary-button" type="submit" disabled={!ready || !confirmed} data-testid="external-admission-submit">{t("admit")}</button></form>
  </section>;
}
