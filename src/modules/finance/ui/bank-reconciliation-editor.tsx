"use client";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { bankReconciliationReviewInput, type bankReconciliationMatchInput } from "../domain/bank-reconciliation";
import { bankReconciliationSourcesSchema, bankReconciliationPostingsSchema, bankReconciliationReviewSchema } from "../domain/bank-reconciliation-workspace";
import { BankReconciliationPlan } from "./bank-reconciliation-plan";
import { useCompensationRead } from "./use-compensation-read";

type Allocation = { id: string; amount: string; label: string };
type Draft = Omit<z.infer<typeof bankReconciliationMatchInput>, "idempotencyKey">;
const endpoint = "/api/finance/bank-reconciliation/read";
function AmountSelection({ id, amount, selected, label, disabled, onChange }: { id: string; amount: string; selected: Allocation[]; label: string; disabled: boolean; onChange: (value: Allocation[]) => void }) {
  const t = useTranslations("BankReconciliation"), chosen = selected.find(row => row.id === id);
  return <div className="resource-form"><label className="checkbox-field"><input type="checkbox" checked={!!chosen} disabled={disabled || !chosen && selected.length >= 500} onChange={event => onChange(event.target.checked ? [...selected, { id, amount, label }] : selected.filter(row => row.id !== id))}/><span dir="auto">{label}</span></label>
    {chosen ? <label className="field"><span>{t("allocatedAmount")}</span><input type="text" inputMode="decimal" value={chosen.amount} required maxLength={19} pattern="(?:0|[1-9][0-9]{0,15})\.[0-9]{2}" disabled={disabled}
      data-testid="bank-match-allocation" onChange={event => onChange(selected.map(row => row.id === id ? { ...row, amount: event.target.value } : row))}/></label> : null}</div>;
}
function Confirmation({ body, locale, ready, onInvalidate, onMatch }: { body: string; locale: AppLocale; ready: boolean; onInvalidate: () => void; onMatch: (draft: Draft) => void }) {
  const t = useTranslations("BankReconciliation"), review = useCompensationRead("/api/finance/bank-reconciliation/review", bankReconciliationReviewSchema, onInvalidate, body);
  if (review.pending) return <SkeletonBlock rows={4}/>;
  if (review.error) return <p role="alert">{t(review.error)}</p>;
  if (!review.data) return null;
  return <form className="resource-form" data-testid="bank-match-review" onSubmit={event => {
    event.preventDefault();
    if (!ready || new FormData(event.currentTarget).get("confirmed") !== "on") return;
    const input: unknown = JSON.parse(body);
    onMatch({ ...bankReconciliationReviewInput.parse(input), reviewFingerprint: review.data!.reviewFingerprint });
  }}><BankReconciliationPlan plan={review.data.plan} locale={locale}/><label className="checkbox-field"><input type="checkbox" name="confirmed" required disabled={!ready} data-testid="bank-match-confirm"/>{t("confirmMatch")}</label>
    <button className="primary-button" disabled={!ready} data-testid="bank-match-submit">{t("match")}</button></form>;
}
export function BankReconciliationEditor({ accountId, currency, locale, ready, revision, onInvalidate, onMatch }: { accountId: string; currency: string; locale: AppLocale; ready: boolean; revision: number; onInvalidate: () => void; onMatch: (draft: Draft) => void }) {
  const t = useTranslations("BankReconciliation"), [afterSource, setAfterSource] = useState<string | undefined>(), [afterPosting, setAfterPosting] = useState<string | undefined>();
  const [actual, setActual] = useState<Allocation[]>([]), [expected, setExpected] = useState<Allocation[]>([]), [reason, setReason] = useState(""), [action, setAction] = useState(""), [body, setBody] = useState<string | null>(null), [invalid, setInvalid] = useState(false);
  const sources = useCompensationRead(endpoint, bankReconciliationSourcesSchema, onInvalidate, JSON.stringify({ operation: "SOURCES", accountId, currency, after: afterSource }), revision);
  const postings = useCompensationRead(endpoint, bankReconciliationPostingsSchema, onInvalidate, JSON.stringify({ operation: "POSTINGS", accountId, currency, after: afterPosting, lineId: actual[0]?.id }), revision);
  const changeActual = (value: Allocation[]) => { setActual(value); setBody(null); setInvalid(false); }, changeExpected = (value: Allocation[]) => { setExpected(value); setBody(null); setInvalid(false); };
  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!ready) return;
    const input = bankReconciliationReviewInput.safeParse({ action: "MATCH", accountId, currency, expected: expected.map(({ id, amount }) => ({ id, amount })), actual: actual.map(({ id, amount }) => ({ id, amount })), reason, varianceAction: action.trim() || null });
    setInvalid(!input.success); setBody(input.success ? JSON.stringify(input.data) : null);
  };
  const editable = ready && sources.data?.canReconcile === true;
  return <section className="resource-form"><h2>{t("newMatch")}</h2><p>{t("guidance")}</p><form className="resource-form" onSubmit={review} data-testid="bank-match-editor"><fieldset className="resource-form" disabled={!ready}><legend>{t("actual")}</legend>
    {sources.error ? <p role="alert">{t(sources.error)}</p> : sources.pending ? <SkeletonBlock rows={3}/> : <><ul className="resource-list" data-testid="bank-match-sources">{sources.data?.items.map(row => <li key={row.id}>
      <p><time dateTime={row.fact.postedDate ?? undefined}>{row.fact.postedDate ?? t("nonmonetaryEvidence")}</time> · {t(`source_${row.state}`)}</p>
      <AmountSelection id={row.id} amount={row.remaining.amount} selected={actual} label={[row.fact.name, row.fact.reference, row.fact.amount ? formatCurrencyAmount(locale, row.fact.amount.amount, currency) : t("nonmonetaryEvidence")].filter(Boolean).join(" · ")}
        disabled={!editable || !row.eligible} onChange={changeActual}/></li>)}</ul>{!sources.data?.items.length ? <p>{t("empty")}</p> : null}<div className="form-actions">
      {afterSource ? <button className="secondary-button" type="button" onClick={() => setAfterSource(undefined)}>{t("first")}</button> : null}{sources.data?.next ? <button className="secondary-button" type="button" onClick={() => setAfterSource(sources.data!.next!)}>{t("next")}</button> : null}</div></>}
    </fieldset><fieldset className="resource-form" disabled={!ready}><legend>{t("expected")}</legend><p>{t("suggestionGuidance")}</p>
      {postings.data?.matching ? <p>{t("matchingRules", { days: postings.data.matching.dateWindowDays, tolerance: formatCurrencyAmount(locale, postings.data.matching.amountTolerance, currency), reference: t(`reference_${postings.data.matching.reference}`), timezone: postings.data.matching.timezone })}</p> : null}
      {postings.error ? <p role="alert">{t(postings.error)}</p> : postings.pending ? <SkeletonBlock rows={3}/> : <><ul className="resource-list" data-testid="bank-match-postings">{postings.data?.items.map(row => <li key={row.id}>
        <p>{formatDateTime(locale, new Date(row.occurredAt), { timeZone: postings.data?.matching?.timezone ?? "UTC" })} · {formatCurrencyAmount(locale, row.original.amount, currency)}{row.suggested ? <span> · {t("suggested")}</span> : null}</p>
        <AmountSelection id={row.id} amount={row.remaining.amount} selected={expected} label={row.reference} disabled={!editable || !row.canReconcile || row.remaining.amount === "0.00"} onChange={changeExpected}/></li>)}</ul>{!postings.data?.items.length ? <p>{t("empty")}</p> : null}
        <div className="form-actions">{afterPosting ? <button className="secondary-button" type="button" onClick={() => setAfterPosting(undefined)}>{t("first")}</button> : null}{postings.data?.next ? <button className="secondary-button" type="button" onClick={() => setAfterPosting(postings.data!.next!)}>{t("next")}</button> : null}</div></>}
    </fieldset><fieldset className="resource-form" disabled={!editable}><legend>{t("review")}</legend><p>{t("selected", { expected: expected.length, actual: actual.length })}</p>
      <ul className="resource-list">{([...expected.map(row => ({ ...row, side: "expected" as const })), ...actual.map(row => ({ ...row, side: "actual" as const }))]).map(row => <li key={row.side + row.id}><p dir="auto">{t(row.side)} · {row.label} · <bdi>{row.amount} {currency}</bdi></p><button className="secondary-button" type="button" onClick={() => row.side === "expected" ? changeExpected(expected.filter(value => value.id !== row.id)) : changeActual(actual.filter(value => value.id !== row.id))}>{t("removeSelection")}</button></li>)}</ul>
      <label className="field"><span>{t("reason")}</span><textarea required minLength={8} maxLength={2000} dir="auto" value={reason} data-testid="bank-match-reason" onChange={event => { setReason(event.target.value); setBody(null); }}/></label>
      <label className="field"><span>{t("varianceAction")}</span><textarea minLength={8} maxLength={2000} dir="auto" value={action} data-testid="bank-match-action" onChange={event => { setAction(event.target.value); setBody(null); }}/></label><p>{t("varianceGuidance")}</p>
      {invalid ? <p role="alert">{t("validation")}</p> : null}<button className="secondary-button" disabled={!editable || !actual.length || !expected.length} data-testid="bank-match-review-button">{t("review")}</button></fieldset></form>
    {body ? <Confirmation key={body} body={body} locale={locale} ready={editable} onInvalidate={onInvalidate} onMatch={onMatch}/> : null}
  </section>;
}
