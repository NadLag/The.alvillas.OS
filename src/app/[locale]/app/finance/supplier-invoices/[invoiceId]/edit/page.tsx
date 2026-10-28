import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplierInvoice, getSupplierInvoiceEditor, SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-service";
import { requireSupplierInvoiceAccess } from "@/modules/finance/ui/supplier-invoice-access";
import { SupplierInvoiceForm } from "@/modules/finance/ui/supplier-invoice-form";
export default async function Page({ params }: { params: Promise<{ locale: string; invoiceId: string }> }) {
  const values = await params, locale = safeLocale(values.locale); setRequestLocale(locale); const t = await getTranslations("SupplierInvoices"), actor = await requireSupplierInvoiceAccess(locale, "edit"); let invoice, editor;
  try { invoice = await getSupplierInvoice(actor, values.invoiceId); if (!invoice.canEdit) notFound(); editor = await getSupplierInvoiceEditor(actor, "edit", invoice.supplierId); }
  catch (error) { if (error instanceof SupplierInvoiceAccessError || error instanceof z.ZodError) notFound(); throw error; }
  return <AdminShell className="resource-page supplier-page invoice-page"><ShellHeader eyebrow={invoice.reference} title={t("edit")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/supplier-invoices/${invoice.id}`}>{t("view")}</Link>} /><SupplierInvoiceForm key={invoice.version} locale={locale} invoice={invoice} editor={editor} /></AdminShell>;
}
