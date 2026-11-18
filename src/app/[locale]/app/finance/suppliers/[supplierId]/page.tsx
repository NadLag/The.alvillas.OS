import Link from "next/link";
import { notFound } from "next/navigation";
import { listSupplierInvoices, SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-service";
import { readSupplierPriceLists } from "@/modules/finance/application/supplier-price-list";
import { SupplierPriceListEditor } from "@/modules/finance/ui/supplier-price-list-editor";
import { formatCurrencyAmount, formatDate } from "@/i18n/format";
import { readDocumentSourceWorkspace } from "@/modules/documents/application/document-workspace";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "@/modules/documents/domain/document-command";
import { prisma } from "@/platform/db/client";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplier, SupplierAccessError } from "@/modules/finance/application/supplier-service";
import { supplierActor } from "@/modules/finance/ui/supplier-access";
import { SupplierArchiveForm } from "@/modules/finance/ui/supplier-form";
export default async function Page({ params, searchParams }: {
  params: Promise<{ locale: string; supplierId: string }>; searchParams: Promise<{ priceAfter?: string }>;
}) {
  const { locale: value, supplierId } = await params, locale = safeLocale(value); setRequestLocale(locale);
  const t = await getTranslations("Suppliers"), actor = await supplierActor(locale); let supplier;
  try { supplier = await getSupplier(actor, supplierId); } catch (error) { if (error instanceof SupplierAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const query = await searchParams, cursor = z.uuid().optional().safeParse(query.priceAfter);
  if (!cursor.success) notFound();
  const [prices, archive, finance, invoices] = await Promise.all([
    readSupplierPriceLists(actor, supplier.id, cursor.data).catch((error: unknown) => {
      if (error instanceof SupplierAccessError) return null;
      throw error;
    }),
    actor.authContext.permissions.has("document:view")
      ? readDocumentSourceWorkspace(actor, { source: { kind: "SUPPLIER", id: supplier.id }, kind: "FILE" }, { db: prisma })
        .catch((error: unknown) => {
          if (error instanceof DocumentAccessError || error instanceof DocumentConfigurationError || error instanceof DocumentConflictError) return null;
          throw error;
        })
      : null,
    actor.authContext.permissions.has("supplier_invoice:view")
      ? listSupplierInvoices(actor, { supplierId: supplier.id }).catch((error: unknown) => {
        if (error instanceof SupplierInvoiceAccessError) return null;
        throw error;
      })
      : null,
    getTranslations("SupplierInvoices")
  ]);
  const archivePath = "/" + locale + "/app/documents";
  return <AdminShell className="resource-page supplier-page" testId="supplier-page"><ShellHeader eyebrow={supplier.reference} title={supplier.displayName} subtitle={supplier.category} actions={<>{supplier.canEdit && !supplier.archived ? <Link className="primary-button" data-testid="supplier-edit" href={`/${locale}/app/finance/suppliers/${supplier.id}/edit`}>{t("edit")}</Link> : null}<Link className="secondary-button" href={`/${locale}/app/finance/suppliers`}>{t("back")}</Link></>} />
    {supplier.archived ? <p className="status-badge" data-testid="supplier-archived">{t("archived")}</p> : null}<dl className="detail-grid">{(["contactName", "email", "phone", "address", "externalReference"] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd dir="auto">{supplier[key] ?? t("notProvided")}</dd></div>)}</dl>
    {prices ? <section className="panel resource-form" aria-label={t("prices.title")}>
      <h2>{t("prices.title")}</h2>
      {prices.active ? <p>{t("prices.active", { version: prices.activeVersion ?? 0 })}</p> : <p>{t("prices.empty")}</p>}
      {prices.canEdit ? <SupplierPriceListEditor key={prices.version} supplierId={supplier.id} version={prices.version} initial={prices.active} /> : null}
      {prices.history.length ? <ol className="resource-list">
        {prices.history.map(record => <li key={record.id} className="resource-form"><details open={record.version === prices.activeVersion}>
          <summary>{t("prices.version", { version: record.version, date: formatDate(locale, record.from, { timeZone: "UTC" }) })}</summary>
          <p dir="auto">{record.reason}</p>
          <ul className="resource-list">{record.data.items.map(item => <li key={item.code} className="resource-row">
            <span><strong dir="auto">{item.name}</strong><small dir="auto">{item.code} {" / "} {item.unit}</small></span>
            <span className="money">{formatCurrencyAmount(locale, item.amount, record.data.currency)}</span>
          </li>)}</ul>
        </details></li>)}
      </ol> : null}
      {prices.next ? <Link className="secondary-button" href={"?priceAfter=" + prices.next}>{t("prices.older")}</Link> : null}
    </section> : null}
    {archive ? <section className="panel resource-form" aria-label={t("documents.title")}>
      <h2>{t("documents.title")}</h2>
      <Link className="secondary-button" href={archivePath + "?supplier=" + supplier.id}>{t("documents.open")}</Link>
      {archive.items.length ? <ul className="resource-list">{archive.items.slice(0, 8).map(item => <li key={item.id}>
        <span dir="auto">{item.title}</span>
      </li>)}</ul> : <p>{t("documents.empty")}</p>}
    </section> : null}
    {finance ? <section className="panel resource-form" aria-label={t("payables.title")}>
      <h2>{t("payables.title")}</h2>
      <Link className="secondary-button" href={"/" + locale + "/app/finance/supplier-invoices?supplier=" + supplier.id}>{t("payables.open")}</Link>
      {finance.invoices.length ? <ul className="resource-list">{finance.invoices.slice(0, 5).map(invoice => <li key={invoice.id}>
        <Link className="resource-row" href={"/" + locale + "/app/finance/supplier-invoices/" + invoice.id}>
          <span><strong dir="auto">{invoice.invoiceNumber}</strong><small>{invoice.archived ? invoices("archived") : invoices("states." + invoice.state)}</small></span>
          <span className="money">{formatCurrencyAmount(locale, invoice.amount, invoice.currency)}</span>
        </Link>
      </li>)}</ul> : <p>{t("payables.empty")}</p>}
    </section> : null}
    {supplier.canEdit ? <SupplierArchiveForm key={supplier.version} supplier={supplier} /> : null}
  </AdminShell>;
}
