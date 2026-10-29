import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplierInvoiceEditor, SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-service";
import { requireSupplierInvoiceAccess } from "@/modules/finance/ui/supplier-invoice-access";
import { SupplierInvoiceForm } from "@/modules/finance/ui/supplier-invoice-form";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ supplier?: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale); const t = await getTranslations("SupplierInvoices"), actor = await requireSupplierInvoiceAccess(locale, "create"); let editor;
  try { editor = await getSupplierInvoiceEditor(actor, "create", (await searchParams).supplier); } catch (error) { if (error instanceof SupplierInvoiceAccessError || error instanceof z.ZodError) notFound(); throw error; }
  return <AdminShell className="resource-page supplier-page invoice-page"><ShellHeader eyebrow={t("eyebrow")} title={t("create")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/supplier-invoices`}>{t("backList")}</Link>} /><SupplierInvoiceForm locale={locale} editor={editor} /></AdminShell>;
}
