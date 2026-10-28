import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplier, SupplierAccessError } from "@/modules/finance/application/supplier-service";
import { supplierActor } from "@/modules/finance/ui/supplier-access";
import { SupplierForm } from "@/modules/finance/ui/supplier-form";
export default async function Page({ params }: { params: Promise<{ locale: string; supplierId: string }> }) {
  const { locale: value, supplierId } = await params, locale = safeLocale(value); setRequestLocale(locale);
  const t = await getTranslations("Suppliers"), actor = await supplierActor(locale); let supplier;
  try { supplier = await getSupplier(actor, supplierId); } catch (error) { if (error instanceof SupplierAccessError || error instanceof z.ZodError) notFound(); throw error; }
  if (!supplier.canEdit || supplier.archived) notFound();
  return <AdminShell className="resource-page supplier-page" testId="supplier-edit-page"><ShellHeader eyebrow={supplier.reference} title={t("edit")} subtitle={supplier.displayName} actions={<Link className="secondary-button" href={`/${locale}/app/finance/suppliers/${supplier.id}`}>{t("back")}</Link>} /><SupplierForm key={supplier.version} locale={locale} supplier={supplier} /></AdminShell>;
}
