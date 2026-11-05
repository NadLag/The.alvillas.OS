"use client";
import { useCallback, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { Money } from "@/platform/money/money";
import { externalRefundSupervisionReviewInput, externalRefundSupervisionAdmissionInput } from "../domain/external-payment-refund-supervision";
import { externalRefundSupervisionListSchema, externalRefundSupervisionReviewSchema, externalRefundSupervisedAdmissionReviewSchema,
  externalRefundSupervisedReceiptSchema, externalRefundSupervisedRecoverySchema } from "../domain/external-payment-refund-supervision-workspace";
import { externalRefundFeePlanSchema } from "../domain/external-payment-refund-workspace";
import { ExternalRefundFeeCorrection } from "./external-payment-refund-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCommand } from "./use-compensation-command";
import { companyExpenseFormText as text } from "./company-expense-form-text";

const base = "/api/finance/external-payments/refunds/supervision", readPath = base + "/read", commandPath = base + "/command", recoveryPath = base + "/recover", recoveryInput = (key: string) => ({ key });
type Command = z.infer<typeof externalRefundSupervisionAdmissionInput>;
type Receipt = z.infer<typeof externalRefundSupervisedReceiptSchema>;
type SourceReview = z.infer<typeof externalRefundSupervisionReviewSchema>;
type Props = { depositId: string; scope: string; locale: AppLocale; onInvalidate: () => void; onAdmitted: (depositId: string) => void };
const requestBody = (input: Command) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "ADMIT", input }) });
const accept = (receipt: Receipt, input: Command | null, nonce: string | null) => receipt.idempotencyKey === nonce && (!input || receipt.intentId === input.intentId && receipt.reviewId === input.reviewId && receipt.reviewFingerprint === input.reviewFingerprint && receipt.reason === input.reason);

export function ExternalPaymentRefundSupervisionWorkspace(props: Props) {
  const { onAdmitted } = props;
  const t = useTranslations("ExternalRefundSupervision"), common = useTranslations("ExternalRefunds"), paging = useTranslations("GuestDeposits"), [after, setAfter] = useState<string | undefined>(), [selected, setSelected] = useState<string | null>(null),
    success = useCallback((receipt: Receipt) => onAdmitted(receipt.depositId), [onAdmitted]),
    command = useCompensationCommand({ storageKey: "alvillas:external-refund-supervision:" + props.scope, inputSchema: externalRefundSupervisionAdmissionInput,
      receiptSchema: externalRefundSupervisedReceiptSchema, recoverySchema: externalRefundSupervisedRecoverySchema, requestPath: commandPath, recoveryPath, recoveryInput, requestBody,
      accept, onSuccess: success, onInvalidate: props.onInvalidate }),
    list = useCompensationRead(readPath, externalRefundSupervisionListSchema, props.onInvalidate, JSON.stringify({ operation: "LIST", input: { depositId: props.depositId, after } }));
  if (!list.pending && !list.error && !list.data?.items.length && !list.data?.next && !after && command.state === "ready") return null;
  const blocked = command.state !== "ready";
  return <section className="resource-form" data-testid="supervised-refund-workspace"><h2>{t("title")}</h2><p>{t("guidance")}</p>
    <p role="status" data-testid="supervised-refund-command-status">{common("command_" + command.state)}</p>
    {["uncertain", "recoveryUnavailable", "offline", "terminal"].includes(command.state) ? <button className="secondary-button" type="button" onClick={() => { void command.recover(); }} data-testid="supervised-refund-recover">{common("recover")}</button> : null}
    {command.state === "uncertain" ? <button className="secondary-button" type="button" onClick={() => { void command.send(); }}>{common("retryExact")}</button> : null}
    {list.error ? <p role="alert">{common(list.error)}</p> : list.pending || !list.data ? <SkeletonBlock rows={2} /> : <>
      <ul data-testid="supervised-refund-sources">{list.data.items.map(item => <li key={item.intentId}><button className="secondary-button" type="button" disabled={blocked} onClick={() => setSelected(item.intentId)} data-testid="supervised-refund-open">
        <span dir="ltr">{item.refundId}</span> · {formatCurrencyAmount(props.locale, item.amount.amount, item.amount.currency)} · {formatDateTime(props.locale, new Date(item.refundedAt), { timeZone: "UTC" })}</button></li>)}</ul>
      {!list.data.items.length ? <p>{t("empty")}</p> : null}<div className="form-actions">{after ? <button className="secondary-button" disabled={blocked} type="button" onClick={() => { setAfter(undefined); setSelected(null); }}>{paging("first")}</button> : null}
        {list.data.next ? <button className="secondary-button" disabled={blocked} type="button" onClick={() => { setAfter(list.data!.next!); setSelected(null); }}>{paging("next")}</button> : null}</div>
      {selected && list.data.items.some(item => item.intentId === selected) ? <ReviewSource key={selected} {...props} intentId={selected} ready={!blocked} send={input => { void command.send(input); }} /> : null}</>}
  </section>;
}
function ReviewSource({ intentId, ready, send, ...props }: Props & { intentId: string; ready: boolean; send: (input: Omit<Command, "idempotencyKey">) => void }) {
  const t = useTranslations("ExternalRefundSupervision"), common = useTranslations("ExternalRefunds"), [review, setReview] = useState<SourceReview | null>(null), [pending, start] = useTransition(), [error, setError] = useState(false);
  if (review) return <AdmitReviewed {...props} review={review} ready={ready} send={send} />;
  return <form className="resource-form" data-testid="supervised-refund-source-review" onSubmit={event => {
    event.preventDefault(); const input = externalRefundSupervisionReviewInput.safeParse({ intentId, reason: text(new FormData(event.currentTarget).get("reason")) });
    if (!input.success || !ready) { setError(true); return; }
    start(async () => { setError(false); try { const response = await fetch(readPath, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "REVIEW", input: input.data }) });
      if (response.status === 401 || response.status === 403) { props.onInvalidate(); return; } if (!response.ok) throw Error();
      const current = externalRefundSupervisionReviewSchema.parse(await response.json()); if (current.intentId !== intentId || current.reason !== input.data.reason) throw Error(); setReview(current);
    } catch { setError(true); } });
  }}><p>{t("originalPreserved")}</p><label className="field"><span>{t("reason")}</span><textarea name="reason" required minLength={6} maxLength={500} dir="auto" disabled={pending || !ready} data-testid="supervised-refund-reason" /></label>
    {error ? <p role="alert">{common("unavailable")}</p> : null}<button className="secondary-button" disabled={pending || !ready} type="submit" data-testid="supervised-refund-review">{t("review")}</button></form>;
}
function AdmitReviewed({ review, ready, send, ...props }: Props & { review: SourceReview; ready: boolean; send: (input: Omit<Command, "idempotencyKey">) => void }) {
  const t = useTranslations("ExternalRefundSupervision"), common = useTranslations("ExternalRefunds"), [acceptedFingerprint, setAcceptedFingerprint] = useState<string | null>(null),
    feeInput = { intentId: review.intentId, reviewId: review.reviewId, reviewFingerprint: review.reviewFingerprint, reason: review.reason },
    hasFee = Money.of(review.settlement.fee.amount, review.settlement.fee.currency).amount.gt(0),
    fee = useCompensationRead(hasFee ? readPath : null, externalRefundFeePlanSchema, props.onInvalidate, JSON.stringify({ operation: "GET_FEE", input: feeInput })),
    feeReady = !hasFee || !fee.pending && !fee.error && fee.data?.intentId === review.intentId && Money.of(fee.data.returnedFee.amount, fee.data.returnedFee.currency).equals(Money.of(review.settlement.fee.amount, review.settlement.fee.currency)) && (fee.data.state === "APPROVED" || fee.data.state === "READY"),
    admission = useCompensationRead(feeReady ? readPath : null, externalRefundSupervisedAdmissionReviewSchema, props.onInvalidate, JSON.stringify({ operation: "REVIEW_ADMISSION", input: { intentId: review.intentId, reason: review.reason } })),
    current = admission.data?.intentId === review.intentId && admission.data.reason === review.reason && admission.data.originalRequestedBy === review.originalRequestedBy && admission.data.prospectiveAdmitter === review.prospectiveAdmitter &&
      admission.data.refundedAt === review.refundedAt && Money.of(admission.data.amount.amount, admission.data.amount.currency).equals(Money.of(review.amount.amount, review.amount.currency)) ? admission.data : null,
    canAdmit = ready && feeReady && !admission.pending && !admission.error && Boolean(current), confirmed = Boolean(current && acceptedFingerprint === current.reviewFingerprint);
  return <section className="resource-form" data-testid="supervised-refund-admission"><h3>{t("admissionTitle")}</h3><p>{t("originalPreserved")}</p><p dir="auto">{review.reason}</p>
    <dl className="compensation-evidence"><div><dt>{common("gross")}</dt><dd>{formatCurrencyAmount(props.locale, review.amount.amount, review.amount.currency)}</dd></div>
      <div><dt>{common("refundedAt")}</dt><dd>{formatDateTime(props.locale, new Date(review.refundedAt), { timeZone: "UTC" })}</dd></div>
      <div><dt>{common("returnedFee")}</dt><dd>{formatCurrencyAmount(props.locale, review.settlement.fee.amount, review.settlement.fee.currency)}</dd></div>
      <div><dt>{common("net")}</dt><dd>{formatCurrencyAmount(props.locale, review.settlement.net.amount, review.settlement.net.currency)}</dd></div></dl>
    {hasFee ? fee.error ? <p role="alert">{common(fee.error)}</p> : fee.pending || !fee.data ? <SkeletonBlock rows={2} /> : <ExternalRefundFeeCorrection plan={fee.data} locale={props.locale} onInvalidate={props.onInvalidate}
      preparation={{ path: commandPath, input: feeInput }} refresh={async () => { await fee.refresh(); await admission.refresh(); }} /> : null}
    {admission.error ? <p role="alert">{common(admission.error)}</p> : admission.pending && feeReady ? <SkeletonBlock rows={2} /> : null}
    <form className="resource-form" onSubmit={event => { event.preventDefault(); if (canAdmit && confirmed && current) send({ intentId: review.intentId, reviewId: current.reviewId, reviewFingerprint: current.reviewFingerprint, reason: review.reason }); }}>
      <label className="compensation-cost-check"><input type="checkbox" required disabled={!canAdmit} checked={confirmed} onChange={event => setAcceptedFingerprint(event.target.checked && current ? current.reviewFingerprint : null)} data-testid="supervised-refund-confirm" /><span>{t("confirm")}</span></label>
      <button className="primary-button" disabled={!canAdmit || !confirmed} type="submit" data-testid="supervised-refund-admit">{common("admit")}</button></form>
  </section>;
}
