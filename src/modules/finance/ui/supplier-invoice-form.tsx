"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createSupplierInvoiceInput, updateSupplierInvoiceInput, archiveSupplierInvoiceInput } from "../domain/supplier-invoice";
import { createSupplierInvoiceAction, updateSupplierInvoiceAction, setSupplierInvoiceArchivedAction } from "../application/supplier-invoice-actions";
import type { getSupplierInvoice, getSupplierInvoiceEditor } from "../application/supplier-invoice-service";
import { InvoiceSourcePicker, type InvoiceSourceOption } from "./supplier-invoice-source-picker";

type Invoice = Awaited<ReturnType<typeof getSupplierInvoice>>;
type Editor = Awaited<ReturnType<typeof getSupplierInvoiceEditor>>;
type ErrorCode = "forbidden" | "conflict" | "validation" | "policy" | "error";
export function SupplierInvoiceForm({ locale, editor, invoice }: { locale: string; editor: Editor; invoice?: Invoice }) {
  const t = useTranslations("SupplierInvoices"), router = useRouter(), mode = invoice ? "edit" : "create";
  const [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null), [idempotencyKey] = useState(() => crypto.randomUUID());
  const [supplier, setSupplier] = useState<InvoiceSourceOption | null>(editor.supplier);
  const [lines, setLines] = useState(() => (invoice?.lines ?? [{ propertyId: null, reservationId: null, propertyName: null, reservationReference: null, category: "", costCenter: null, amount: "" }]).map((line, index) => ({ ...line, key: `line-${index}`, property: line.propertyId ? { id: line.propertyId, label: line.propertyName ?? t("unavailableProperty"), description: "" } : null as InvoiceSourceOption | null,
    reservation: line.reservationId ? { id: line.reservationId, label: line.reservationReference ?? t("unavailableReservation"), description: "" } : null as InvoiceSourceOption | null })));
  return <form className="resource-form" data-testid="supplier-invoice-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const form = new FormData(event.currentTarget), fields = { invoiceNumber: form.get("invoiceNumber"), issuedOn: form.get("issuedOn"), dueOn: form.get("dueOn") || null, currency: form.get("currency"), purpose: form.get("purpose"), reason: form.get("reason"),
      lines: lines.map(line => { const amount = form.get(`amount-${line.key}`); return { propertyId: line.property?.id ?? null, reservationId: line.reservation?.id ?? null, category: form.get(`category-${line.key}`), costCenter: form.get(`costCenter-${line.key}`) || null, amount: typeof amount === "string" ? amount.replace(",", ".") : amount }; }) };
    const parsed = invoice ? updateSupplierInvoiceInput.safeParse({ ...fields, id: invoice.id, expectedVersion: invoice.version }) : createSupplierInvoiceInput.safeParse({ ...fields, supplierId: supplier?.id, idempotencyKey });
    if (!parsed.success) { setError("validation"); return; } setError(null);
    startTransition(async () => {
      try { const result = invoice ? await updateSupplierInvoiceAction(parsed.data) : await createSupplierInvoiceAction(parsed.data);
        if (!result.ok) setError(result.code); else { router.push(`/${locale}/app/finance/supplier-invoices/${result.data.id}`); router.refresh(); }
      } catch { setError("error"); }
    });
  }}>
    {error ? <div role="alert"><p data-testid="invoice-error">{t(error)}</p>{error === "conflict" ? <button type="button" className="secondary-button" onClick={() => router.refresh()}>{t("reload")}</button> : null}</div> : null}
    <fieldset disabled={pending}><legend>{t(invoice ? "edit" : "create")}</legend><div className="form-grid two">
      {invoice ? <p>{invoice.supplierName}</p> : <InvoiceSourcePicker kind="supplier" mode={mode} value={supplier} onChange={setSupplier} />}
      <label className="field"><span>{t("invoiceNumber")}</span><input name="invoiceNumber" data-testid="invoice-number" dir="auto" defaultValue={invoice?.invoiceNumber} maxLength={160} required /></label>
      <label className="field"><span>{t("issuedOn")}</span><input name="issuedOn" data-testid="invoice-issued" type="date" defaultValue={invoice?.issuedOn} required /></label>
      <label className="field"><span>{t("dueOn")}</span><input name="dueOn" data-testid="invoice-due" type="date" defaultValue={invoice?.dueOn ?? ""} /></label>
      <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="invoice-currency" defaultValue={invoice?.currency ?? (editor.currencies.some(row => row.code === editor.baseCurrency) ? editor.baseCurrency : "")} required><option value="">{t("chooseCurrency")}</option>{editor.currencies.map(row => <option key={row.code} value={row.code}>{row.code}</option>)}</select></label>
      <label className="field"><span>{t("purpose")}</span><textarea name="purpose" data-testid="invoice-purpose" dir="auto" defaultValue={invoice?.purpose} minLength={3} maxLength={1000} required /></label>
    </div></fieldset>
    <fieldset disabled={pending}><legend>{t("lines")}</legend>{lines.map((line, index) => <fieldset className="invoice-line" data-testid="invoice-line" key={line.key}><legend>{t("line", { number: index + 1 })}</legend><div className="form-grid two">
      <InvoiceSourcePicker kind="property" mode={mode} value={line.property} onChange={property => setLines(current => current.map(row => row.key === line.key ? { ...row, property, reservation: null } : row))} />
      {line.property ? <InvoiceSourcePicker key={line.property.id} kind="reservation" mode={mode} value={line.reservation} propertyId={line.property.id} onChange={reservation => setLines(current => current.map(row => row.key === line.key ? { ...row, reservation } : row))} /> : <p>{t("company")}</p>}
      <label className="field"><span>{t("category")}</span><input name={`category-${line.key}`} data-testid="invoice-line-category" defaultValue={line.category} maxLength={120} required /></label>
      <label className="field"><span>{t("costCenter")}</span><input name={`costCenter-${line.key}`} defaultValue={line.costCenter ?? ""} maxLength={120} /></label>
      <label className="field"><span>{t("amount")}</span><input name={`amount-${line.key}`} data-testid="invoice-line-amount" defaultValue={line.amount} inputMode="decimal" dir="ltr" maxLength={19} required /></label>
    </div>{lines.length > 1 ? <button className="quiet-button" type="button" onClick={() => setLines(current => current.filter(row => row.key !== line.key))}>{t("removeLine", { number: index + 1 })}</button> : null}</fieldset>)}
      <button className="secondary-button" type="button" data-testid="invoice-add-line" onClick={() => setLines(current => [...current, { key: crypto.randomUUID(), propertyId: null, reservationId: null, propertyName: null, reservationReference: null, category: "", amount: "", costCenter: null, property: null, reservation: null }])}>{t("addLine")}</button>
    </fieldset>
    <fieldset disabled={pending}><legend>{t("reason")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="invoice-reason" minLength={6} maxLength={500} required /></label><div className="form-actions"><button className="primary-button" data-testid="invoice-save" type="submit">{t(pending ? "saving" : "save")}</button></div></fieldset>
  </form>;
}
export function SupplierInvoiceArchiveForm({ invoice }: { invoice: Invoice }) {
  const t = useTranslations("SupplierInvoices"), router = useRouter(), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  return <form className="resource-form" data-testid="invoice-archive-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const parsed = archiveSupplierInvoiceInput.safeParse({ id: invoice.id, expectedVersion: invoice.version, archived: !invoice.archived, reason: new FormData(event.currentTarget).get("reason") });
    if (!parsed.success) { setError("validation"); return; } setError(null);
    startTransition(async () => { try { const result = await setSupplierInvoiceArchivedAction(parsed.data); if (!result.ok) setError(result.code); else router.refresh(); } catch { setError("error"); } });
  }}>
    {error ? <p role="alert" data-testid="invoice-error">{t(error)}</p> : null}
    <fieldset disabled={pending}><legend>{t(invoice.archived ? "restore" : "archive")}</legend><p>{t("archiveGuidance")}</p><label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="invoice-archive-reason" minLength={6} maxLength={500} required /></label><button className="secondary-button" type="submit" data-testid="invoice-archive">{t(pending ? "saving" : invoice.archived ? "restore" : "archive")}</button></fieldset>
  </form>;
}
