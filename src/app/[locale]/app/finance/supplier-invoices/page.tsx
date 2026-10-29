import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { listSupplierInvoices, SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-service";
import { requireSupplierInvoiceAccess } from "@/modules/finance/ui/supplier-invoice-access";
export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; archived?: string; after?: string; supplier?: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const t = await getTranslations("SupplierInvoices"), query = await searchParams, actor = await requireSupplierInvoiceAccess(locale); let result;
  try { result = await listSupplierInvoices(actor, { query: query.q, supplierId: query.supplier, includeArchived: query.archived === "1", after: query.after }); }
  catch (error) { if (error instanceof SupplierInvoiceAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const next = new URLSearchParams(); if (query.q) next.set("q", query.q); if (query.supplier) next.set("supplier", query.supplier); if (query.archived === "1") next.set("archived", "1"); if (result.next) next.set("after", result.next);
  return <AdminShell className="resource-page supplier-page invoice-page" testId="supplier-invoices-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<>{result.canCreate ? <Link className="primary-button" data-testid="invoice-new" href={`/${locale}/app/finance/supplier-invoices/new`}>{t("create")}</Link> : null}<Link className="secondary-button" href={`/${locale}/app`}>{t("backWorkspace")}</Link></>} />
    <form className="resource-form" method="get"><div className="form-grid"><label className="field"><span>{t("search")}</span><input type="search" name="q" data-testid="invoice-search" defaultValue={query.q} maxLength={160} /></label><label className="checkbox-field"><input type="checkbox" name="archived" value="1" defaultChecked={query.archived === "1"} /><span>{t("includeArchived")}</span></label>{query.supplier ? <input type="hidden" name="supplier" value={query.supplier} /> : null}</div><button className="secondary-button" type="submit" data-testid="invoice-search-apply">{t("filter")}</button></form>
    {!result.invoices.length ? <p data-testid="invoices-empty">{t("empty")}</p> : <ul className="resource-list">{result.invoices.map(invoice => <li className="resource-card" data-testid="invoice-row" key={invoice.id}><h2>{invoice.invoiceNumber}</h2><p>{invoice.reference} · {invoice.supplierName}</p><p>{formatCurrencyAmount(locale, invoice.amount, invoice.currency)}</p><span className="status-badge">{t(invoice.archived ? "archived" : "draft")}</span><Link className="secondary-button" data-testid="invoice-open" href={`/${locale}/app/finance/supplier-invoices/${invoice.id}`} prefetch={false}>{t("view")}</Link></li>)}</ul>}
    {result.next ? <Link className="secondary-button" href={`/${locale}/app/finance/supplier-invoices?${next.toString()}`} prefetch={false}>{t("next")}</Link> : null}
  </AdminShell>;
}
