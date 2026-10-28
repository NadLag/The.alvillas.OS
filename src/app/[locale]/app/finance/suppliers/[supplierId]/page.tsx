import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { getSupplier, SupplierAccessError } from "@/modules/finance/application/supplier-service";
import { supplierActor } from "@/modules/finance/ui/supplier-access";
import { SupplierArchiveForm } from "@/modules/finance/ui/supplier-form";
export default async function Page({ params }: { params: Promise<{ locale: string; supplierId: string }> }) {
  const { locale: value, supplierId } = await params, locale = safeLocale(value); setRequestLocale(locale);
  const t = await getTranslations("Suppliers"), actor = await supplierActor(locale); let supplier;
  try { supplier = await getSupplier(actor, supplierId); } catch (error) { if (error instanceof SupplierAccessError || error instanceof z.ZodError) notFound(); throw error; }
  return <AdminShell className="resource-page supplier-page" testId="supplier-page"><ShellHeader eyebrow={supplier.reference} title={supplier.displayName} subtitle={supplier.category} actions={<>{supplier.canEdit && !supplier.archived ? <Link className="primary-button" data-testid="supplier-edit" href={`/${locale}/app/finance/suppliers/${supplier.id}/edit`}>{t("edit")}</Link> : null}<Link className="secondary-button" href={`/${locale}/app/finance/suppliers`}>{t("back")}</Link></>} />
    {supplier.archived ? <p className="status-badge" data-testid="supplier-archived">{t("archived")}</p> : null}<dl className="detail-grid">{(["contactName", "email", "phone", "address", "externalReference"] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd dir="auto">{supplier[key] ?? t("notProvided")}</dd></div>)}</dl>
    {supplier.canEdit ? <SupplierArchiveForm key={supplier.version} supplier={supplier} /> : null}
  </AdminShell>;
}
