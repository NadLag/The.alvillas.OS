import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { requireSupplierAccess } from "@/modules/finance/ui/supplier-access";
import { SupplierForm } from "@/modules/finance/ui/supplier-form";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: value } = await params, locale = safeLocale(value); setRequestLocale(locale); await requireSupplierAccess(locale, "create");
  const t = await getTranslations("Suppliers");
  return <AdminShell className="resource-page supplier-page" testId="supplier-new-page"><ShellHeader eyebrow={t("eyebrow")} title={t("create")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/suppliers`}>{t("back")}</Link>} /><SupplierForm locale={locale} /></AdminShell>;
}
