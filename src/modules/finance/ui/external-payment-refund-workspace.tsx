"use client";
import { useCallback, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { Money } from "@/platform/money/money";
import { externalRefundReconciliationInput, type externalRefundReviewInput } from "../domain/external-payment-refund-command";
import { guestDepositDetailSchema } from "../domain/guest-deposit-workspace";
import { externalRefundCommandSchema, externalRefundReceiptSchema, externalRefundRecoverySchema, externalRefundReviewSchema, externalRefundViewSchema,
  externalRefundAdmissionCommandSchema, externalRefundAdmissionReceiptSchema, externalRefundAdmissionRecoverySchema, externalRefundAdmissionReviewSchema, acceptExternalRefund } from "../domain/external-payment-refund-workspace";
import { useCompensationCommand, storeCompensationNonce } from "./use-compensation-command";
import { useCompensationRead } from "./use-compensation-read";
import { companyExpenseFormText as text } from "./company-expense-form-text";

export type ExternalRefundDraft = z.infer<typeof externalRefundReviewInput>;
type Refunded = z.infer<typeof externalRefundReceiptSchema>;
function originalView(receipt: Refunded) {
  const { sourceState, requestId: ignoredId, failureCode: ignoredFailure, state: ignoredState, ...original } = receipt;
  void ignoredId; void ignoredFailure; void ignoredState; return { ...original, state: sourceState };
}
type Props = { locale: AppLocale; scope: string; draft: ExternalRefundDraft | null; onInvalidate: () => void; onAdmitted: (depositId: string) => void };
const readPath = "/api/finance/external-payments/refunds/read", commandPath = "/api/finance/external-payments/refunds/command", recoveryPath = "/api/finance/external-payments/refunds/recover";
const recoveryInput = (key: string) => ({ key }), statusPath = (id: string) => "/api/finance/external-payments/refunds/status/" + id;
function requestBody(input: z.infer<typeof externalRefundCommandSchema>) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "REQUEST", input: { captureId: input.captureId, refund: { ...input.refund, idempotencyKey: input.idempotencyKey } } }) };
}
function admissionBody(input: z.infer<typeof externalRefundAdmissionCommandSchema>) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "ADMIT", input: { intentId: input.intentId, reviewFingerprint: input.reviewFingerprint } }) };
}
const acceptAdmission = (receipt: z.infer<typeof externalRefundAdmissionReceiptSchema>, input: z.infer<typeof externalRefundAdmissionCommandSchema> | null, nonce: string | null) => receipt.idempotencyKey === nonce && (!input || input.intentId === receipt.id);
function useOriginalDeposit(depositId: string, onInvalidate: () => void) {
  return useCompensationRead("/api/finance/guest-deposits/read", guestDepositDetailSchema, onInvalidate, JSON.stringify({ operation: "DETAIL", depositId }));
}
function OriginalDeposit({ detail }: { detail: z.infer<typeof guestDepositDetailSchema> }) {
  const t = useTranslations("GuestDeposits"), source = detail.summary;
  return <section className="resource-form" data-testid="external-refund-original-deposit"><h3>{t("depositDetails")}</h3><p dir="auto">{source.reservationReference} · {source.propertyName}</p>
    {source.guestName ? <p dir="auto">{source.guestName}</p> : null}<p dir="auto">{source.purpose}</p></section>;
}

export function ExternalPaymentRefundWorkspace(props: Props) {
  const { onAdmitted } = props, [refunded, setRefunded] = useState<Refunded | null>(null), storageKey = "alvillas:external-refund:" + props.scope;
  const confirmed = useCallback((receipt: Refunded) => {
    if (receipt.admission) { onAdmitted(receipt.depositId); return; }
    storeCompensationNonce(storageKey, receipt.idempotencyKey); setRefunded(receipt);
  }, [onAdmitted, storageKey]);
  return refunded ? <AdmissionPhase {...props} refunded={refunded} storageKey={storageKey} /> : <RequestPhase {...props} storageKey={storageKey} onRefunded={confirmed} />;
}
function Recovery({ state, recover, retry }: { state: string; recover: () => void; retry: () => void }) {
  const t = useTranslations("ExternalRefunds");
  return <><p role="status" data-testid="external-refund-command-status">{t("command_" + state)}</p>
    {["uncertain", "recoveryUnavailable", "offline", "terminal"].includes(state) ? <button className="secondary-button" type="button" onClick={recover}>{t("recover")}</button> : null}
    {state === "uncertain" ? <button className="secondary-button" type="button" onClick={retry}>{t("retryExact")}</button> : null}</>;
}
function Reconcile({ request, onInvalidate, refresh }: { request: Pick<z.infer<typeof externalRefundViewSchema>, "id" | "refundId">; onInvalidate: () => void; refresh: () => Promise<void> }) {
  const t = useTranslations("ExternalRefunds"), [pending, start] = useTransition(), [error, setError] = useState(false);
  return <form className="resource-form" data-testid="external-refund-reconcile" onSubmit={event => {
    event.preventDefault(); const refundId = request.refundId ?? text(new FormData(event.currentTarget).get("refundId")), input = externalRefundReconciliationInput.safeParse({ intentId: request.id, refundId });
    if (!input.success) { setError(true); return; }
    start(async () => { setError(false); try {
      const response = await fetch(commandPath, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "RECONCILE", input: input.data }) });
      if (response.status === 401 || response.status === 403) { onInvalidate(); return; } if (!response.ok) throw Error(); await refresh();
    } catch { setError(true); } });
  }}><p>{t("reconcileGuidance")}</p>{request.refundId ? <code dir="ltr">{request.refundId}</code> : <label className="field"><span>{t("providerRefundId")}</span><input name="refundId" dir="ltr" required pattern="[A-Za-z0-9_-]{1,127}" maxLength={127} data-testid="external-refund-provider-id" /></label>}
    {error ? <p role="alert">{t("unavailable")}</p> : null}<button className="secondary-button" disabled={pending} type="submit">{t("reconcile")}</button>
    <button className="secondary-button" disabled={pending} type="button" onClick={() => start(async () => { setError(false); try { await refresh(); } catch { setError(true); } })}>{t("refresh")}</button></form>;
}
function RequestPhase({ storageKey, onRefunded, ...props }: Props & { storageKey: string; onRefunded: (receipt: Refunded) => void }) {
  const t = useTranslations("ExternalRefunds"), [pending, setPending] = useState<Refunded | null>(null), onPending = useCallback((receipt: Refunded) => setPending(receipt), [setPending]);
  const command = useCompensationCommand({ storageKey, inputSchema: externalRefundCommandSchema, receiptSchema: externalRefundReceiptSchema, recoverySchema: externalRefundRecoverySchema,
    requestPath: commandPath, recoveryPath, recoveryInput, statusPath, requestBody, accept: acceptExternalRefund, onPending, onSuccess: onRefunded, onInvalidate: props.onInvalidate });
  if (!props.draft && command.state === "ready") return null;
  return <section className="resource-form" data-testid="external-refund-request"><h2>{t("requestTitle")}</h2><p>{t("requestGuidance")}</p>
    <Recovery state={command.state} recover={() => { void command.recover(); }} retry={() => { void command.send(); }} />
    {pending ? <Reconcile request={pending} onInvalidate={props.onInvalidate} refresh={command.recover} /> : null}
    {pending && ["FAILED", "CANCELLED"].includes(pending.sourceState) ? <p role="alert">{t("providerUnresolved")}</p> : null}
    {props.draft && command.state === "ready" ? <RequestReview {...props} draft={props.draft} send={input => { void command.send(input); }} /> : null}
  </section>;
}
function RequestReview({ draft, locale, onInvalidate, send }: { draft: ExternalRefundDraft; locale: AppLocale; onInvalidate: () => void; send: (input: Omit<z.infer<typeof externalRefundCommandSchema>, "idempotencyKey">) => void }) {
  const t = useTranslations("ExternalRefunds"), [confirmed, setConfirmed] = useState(false), [validation, setValidation] = useState(false),
    read = useCompensationRead(readPath, externalRefundReviewSchema, onInvalidate, JSON.stringify({ operation: "REVIEW", input: draft })), source = useOriginalDeposit(draft.refund.depositId, onInvalidate);
  if (read.error || source.error) return <p role="alert">{t(read.error ?? source.error!)}</p>; if (read.pending || !read.data || source.pending || !source.data) return <SkeletonBlock rows={3} />;
  if (source.data.summary.depositId !== draft.refund.depositId || source.data.providerCapture?.id !== draft.captureId) return <p role="alert">{t("unavailable")}</p>; const review = read.data;
  return <form className="resource-form" data-testid="external-refund-review" onSubmit={event => {
    event.preventDefault(); if (!confirmed) return;
    const input = externalRefundCommandSchema.omit({ idempotencyKey: true }).safeParse({ ...draft, refund: { ...draft.refund, reviewFingerprint: review.reviewFingerprint, reason: text(new FormData(event.currentTarget).get("reason")) } });
    if (input.success) send(input.data); else setValidation(true);
  }}><OriginalDeposit detail={source.data} /><dl className="compensation-evidence"><div><dt>{t("gross")}</dt><dd>{formatCurrencyAmount(locale, review.amount.amount, review.amount.currency)}</dd></div><div><dt>{t("merchant")}</dt><dd dir="auto">{review.account.name}</dd></div></dl>
    <p>{t("requestConfirmation")}</p><label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="external-refund-reason" /></label>
    <label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} data-testid="external-refund-confirm" /><span>{t("confirmRequest")}</span></label>
    {validation ? <p role="alert">{t("validation")}</p> : null}<button className="primary-button" disabled={!confirmed} type="submit" data-testid="external-refund-submit">{t("request")}</button></form>;
}
function AdmissionPhase({ refunded, storageKey, locale, onInvalidate, onAdmitted }: Props & { refunded: Refunded; storageKey: string }) {
  const t = useTranslations("ExternalRefunds"), [confirmed, setConfirmed] = useState(false), [request, setRequest] = useState<z.infer<typeof externalRefundViewSchema>>(() => originalView(refunded)),
    success = useCallback((receipt: z.infer<typeof externalRefundAdmissionReceiptSchema>) => onAdmitted(receipt.depositId), [onAdmitted]);
  const command = useCompensationCommand({ storageKey, inputSchema: externalRefundAdmissionCommandSchema, receiptSchema: externalRefundAdmissionReceiptSchema, recoverySchema: externalRefundAdmissionRecoverySchema,
    requestPath: commandPath, recoveryPath, recoveryInput, requestBody: admissionBody, accept: acceptAdmission, onSuccess: success, onInvalidate });
  const settlementReady = Boolean(request.settlement && Money.of(request.settlement.fee.amount, request.settlement.fee.currency).amount.isZero()),
    read = useCompensationRead(settlementReady ? readPath : null, externalRefundAdmissionReviewSchema, onInvalidate, JSON.stringify({ operation: "REVIEW_ADMISSION", input: { intentId: refunded.id } })), source = useOriginalDeposit(refunded.depositId, onInvalidate);
  const refresh = async () => { await command.recover(); const response = await fetch(statusPath(refunded.id), { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401 || response.status === 403) { onInvalidate(); return; } if (!response.ok) throw Error(); setRequest(externalRefundViewSchema.parse(await response.json())); await read.refresh(); };
  const originalSource = source.data?.summary.depositId === request.depositId && source.data.providerCapture?.id === request.captureId;
  const ready = command.state === "ready" && settlementReady && Boolean(read.data) && !read.pending && !read.error && originalSource && !source.pending && !source.error;
  return <section className="resource-form" data-testid="external-refund-admission"><h2>{t("admissionTitle")}</h2><p>{t("admissionGuidance")}</p>
    <Recovery state={command.state} recover={() => { void command.recover(); }} retry={() => { void command.send(); }} />
    {source.error ? <p role="alert">{t(source.error)}</p> : source.pending ? <SkeletonBlock rows={2} /> : source.data && originalSource ? <OriginalDeposit detail={source.data} /> : <p role="alert">{t("unavailable")}</p>}
    <dl className="compensation-evidence"><div><dt>{t("gross")}</dt><dd>{formatCurrencyAmount(locale, request.amount.amount, request.amount.currency)}</dd></div><div><dt>{t("refundedAt")}</dt><dd>{formatDateTime(locale, new Date(request.refundedAt!), { timeZone: "UTC" })}</dd></div>
      {request.settlement ? <><div><dt>{t("returnedFee")}</dt><dd>{formatCurrencyAmount(locale, request.settlement.fee.amount, request.settlement.fee.currency)}</dd></div><div><dt>{t("net")}</dt><dd>{formatCurrencyAmount(locale, request.settlement.net.amount, request.settlement.net.currency)}</dd></div></> : null}</dl>
    {!settlementReady ? <p role="status">{t(request.settlement ? "feeCorrectionRequired" : "settlementUnavailable")}</p> : null}
    {read.error ? <p role="alert">{t(read.error)}</p> : read.pending && settlementReady ? <SkeletonBlock rows={2} /> : null}
    <Reconcile request={request} onInvalidate={onInvalidate} refresh={refresh} />
    <form className="resource-form" onSubmit={event => { event.preventDefault(); if (ready && confirmed && read.data) void command.send({ intentId: refunded.id, reviewFingerprint: read.data.reviewFingerprint }); }}>
      <label className="compensation-cost-check"><input type="checkbox" required disabled={!ready} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} data-testid="external-refund-admission-confirm" /><span>{t("confirmAdmission")}</span></label>
      <button className="primary-button" disabled={!ready || !confirmed} type="submit" data-testid="external-refund-admission-submit">{t("admit")}</button></form></section>;
}
