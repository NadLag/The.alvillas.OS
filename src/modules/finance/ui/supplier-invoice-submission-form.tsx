"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { getSupplierInvoiceSubmissionPreviewAction, submitSupplierInvoiceAction } from "../application/supplier-invoice-actions";
import type { getSupplierInvoice } from "../application/supplier-invoice-service";
import type { getSupplierInvoiceSubmissionPreview } from "../application/supplier-invoice-policy";

export function SupplierInvoiceSubmissionForm({ invoice, locale }: { invoice: Awaited<ReturnType<typeof getSupplierInvoice>>; locale: string }) {
  const t = useTranslations("SupplierInvoices"), router = useRouter(), prefix = useId();
  const [pending, startTransition] = useTransition(), [nonce] = useState(() => crypto.randomUUID());
  const [occurredOn, setOccurredOn] = useState(invoice.issuedOn), [emergency, setEmergency] = useState(false);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof getSupplierInvoiceSubmissionPreview>> | null>(null);
  const [error, setError] = useState<"forbidden" | "conflict" | "validation" | "policy" | "error" | null>(null);
  const policyInput = { id: invoice.id, expectedVersion: invoice.version, occurredOn, emergency };
  return <form className="resource-form" data-testid="supplier-invoice-submission-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending || !preview) return;
    const form = new FormData(event.currentTarget), lineNotes = Object.fromEntries(invoice.lines.map(line => [line.id, form.get(`note-${line.id}`)]));
    setError(null); startTransition(async () => {
      try {
        const result = await submitSupplierInvoiceAction({ ...policyInput, idempotencyKey: nonce, reason: form.get("reason"), lineNotes });
        if (result.ok) router.refresh(); else setError(result.code);
      } catch { setError("error"); }
    });
  }}>
    <h2>{t("submissionTitle")}</h2><p>{t("submissionDescription")}</p>
    <label className="field"><span>{t("occurredOn")}</span><input data-testid="invoice-economic-date" type="date" required value={occurredOn} disabled={pending}
      onChange={event => { setOccurredOn(event.target.value); setPreview(null); }} /></label>
    <label className="checkbox-field"><input data-testid="invoice-emergency" type="checkbox" checked={emergency} disabled={pending}
      onChange={event => { setEmergency(event.target.checked); setPreview(null); }} /><span>{t("emergency")}</span></label>
    <button className="secondary-button" type="button" data-testid="invoice-preview-policy" disabled={pending || !occurredOn} onClick={() => {
      setError(null); setPreview(null); startTransition(async () => {
        try { const result = await getSupplierInvoiceSubmissionPreviewAction(policyInput); if (result.ok) setPreview(result.data); else setError(result.code); }
        catch { setError("error"); }
      });
    }}>{pending ? t("saving") : t("previewPolicy")}</button>
    {preview ? <section data-testid="invoice-policy-preview" aria-label={t("allocationPreview")}>
      <p>{t("requiredStages", { count: preview.requiredStages })}</p><p>{t("requiredEmergencyNotices", { count: preview.emergencyNotices })}</p>
      <ol className="resource-list">{invoice.lines.map((line, index) => {
        const allocation = preview.lines.find(value => value.id === line.id); if (!allocation) return null;
        return <li className="resource-card" key={line.id}><h3>{t("line", { number: index + 1 })}</h3><p>{line.propertyName ?? t("company")}</p>
          <dl className="detail-grid">{(["owner", "alvillas", "guest"] as const).map(party => <div key={party}><dt>{t(`allocation.${party}`)}</dt>
            <dd>{formatCurrencyAmount(safeLocale(locale), allocation[party].amount, allocation[party].currency)}</dd></div>)}</dl>
          <label className="field" htmlFor={`${prefix}-${line.id}`}><span>{t("lineReviewNote")}</span>
            <textarea id={`${prefix}-${line.id}`} data-testid="invoice-line-review-note" name={`note-${line.id}`} minLength={6} maxLength={1000} required disabled={pending} /></label>
        </li>;
      })}</ol>
      <label className="field"><span>{t("reason")}</span><textarea data-testid="invoice-submit-reason" name="reason" minLength={6} maxLength={500} required disabled={pending} /></label>
      <button className="primary-button" type="submit" data-testid="invoice-submit" disabled={pending}>{pending ? t("saving") : t("submitForReview")}</button>
    </section> : null}
    {error ? <p className="form-error" role="alert" data-testid="invoice-submission-error">{t(error)}</p> : null}
  </form>;
}
