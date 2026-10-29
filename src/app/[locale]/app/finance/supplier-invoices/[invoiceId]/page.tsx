import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDate, formatDateTime } from "@/i18n/format";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplierInvoice, SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-service";
import { requireSupplierInvoiceAccess } from "@/modules/finance/ui/supplier-invoice-access";
import { SupplierInvoiceArchiveForm } from "@/modules/finance/ui/supplier-invoice-form";
import { SupplierInvoiceSubmissionForm } from "@/modules/finance/ui/supplier-invoice-submission-form";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string; invoiceId: string }>; searchParams: Promise<{ revision?: string; before?: string }> }) {
  const values = await params, locale = safeLocale(values.locale); setRequestLocale(locale); const t = await getTranslations("SupplierInvoices"), query = await searchParams, actor = await requireSupplierInvoiceAccess(locale); let invoice;
  try { invoice = await getSupplierInvoice(actor, values.invoiceId, { revisionId: query.revision, beforeVersion: query.before === undefined ? undefined : z.coerce.number().int().nonnegative().parse(query.before) }); }
  catch (error) { if (error instanceof SupplierInvoiceAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const path = `/${locale}/app/finance/supplier-invoices/${invoice.id}`, historical = invoice.revisionId !== invoice.currentRevisionId;
  const date = (value: string) => formatDate(locale, new Date(value + "T00:00:00.000Z"), { timeZone: "UTC" });
  return <AdminShell className="resource-page supplier-page invoice-page" testId="supplier-invoice-detail"><ShellHeader eyebrow={invoice.reference} title={invoice.invoiceNumber} subtitle={invoice.supplierName} actions={<>{invoice.canEdit && !historical ? <Link className="primary-button" data-testid="invoice-edit" href={path + "/edit"}>{t("edit")}</Link> : null}<Link className="secondary-button" href={`/${locale}/app/finance/supplier-invoices`}>{t("backList")}</Link></>} />
    <span className="status-badge" data-testid="invoice-state">{invoice.archived ? t("archived") : t(`states.${invoice.state}`)}</span>{historical ? <p data-testid="invoice-historical">{t("historical")} <Link href={path} prefetch={false}>{t("returnCurrent")}</Link></p> : null}
    <dl className="detail-grid"><div><dt>{t("amount")}</dt><dd data-testid="invoice-total" data-amount={invoice.amount}>{formatCurrencyAmount(locale, invoice.amount, invoice.currency)}</dd></div><div><dt>{t("issuedOn")}</dt><dd>{date(invoice.issuedOn)}</dd></div><div><dt>{t("dueOn")}</dt><dd>{invoice.dueOn ? date(invoice.dueOn) : t("noDueDate")}</dd></div><div><dt>{t("purpose")}</dt><dd data-testid="invoice-purpose-detail">{invoice.purpose}</dd></div></dl>
    <h2>{t("lines")}</h2><ol className="resource-list">{invoice.lines.map((line, index) => <li className="resource-card" data-testid="invoice-detail-line" key={index}><h3>{t("line", { number: index + 1 })}</h3><p>{line.propertyId ? line.propertyName ?? t("unavailableProperty") : t("company")}</p>{line.reservationReference ? <p>{line.reservationReference}</p> : null}<p>{line.category}{line.costCenter ? " · " + line.costCenter : ""}</p><p>{formatCurrencyAmount(locale, line.amount, invoice.currency)}</p></li>)}</ol>
    <h2>{t("history")}</h2><ol className="resource-list" data-testid="invoice-history">{invoice.history.map(revision => <li className="resource-card" key={revision.id}><h3>{t("revision", { number: revision.version + 1 })}</h3><p>{t("createdUtc")}: {formatDateTime(locale, new Date(revision.createdAt), { timeZone: "UTC" })}</p><p>{revision.reason}</p><p>{formatCurrencyAmount(locale, revision.amount, revision.currency)}</p><Link data-testid="invoice-history-open" href={path + "?revision=" + revision.id} prefetch={false}>{t("viewRevision", { number: revision.version + 1 })}</Link></li>)}</ol>
    {invoice.historyNext !== undefined ? <Link href={path + "?before=" + invoice.historyNext + (historical ? "&revision=" + invoice.revisionId : "")} prefetch={false}>{t("previousHistory")}</Link> : null}
    {invoice.approvalId && !historical ? <Link className="secondary-button" data-testid="invoice-approval-link" href={`/${locale}/app/approvals/${invoice.approvalId}`}>{t("viewApproval")}</Link> : null}
    {invoice.canSubmit && !historical ? <SupplierInvoiceSubmissionForm key={`submission-${invoice.version}`} invoice={invoice} locale={locale} /> : null}
    {invoice.canArchive && !historical ? <SupplierInvoiceArchiveForm key={invoice.version} invoice={invoice} /> : null}
  </AdminShell>;
}
