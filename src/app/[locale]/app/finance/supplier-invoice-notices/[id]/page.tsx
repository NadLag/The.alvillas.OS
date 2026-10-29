import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDate } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-access";
import { getSupplierInvoiceNotice } from "@/modules/finance/application/supplier-invoice-notice";

export const dynamic = "force-dynamic";
export default async function SupplierInvoiceNoticePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const input = await params, locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("SupplierInvoices"); let notice;
  try { notice = await getSupplierInvoiceNotice(actor, input.id); }
  catch (error) { if (error instanceof SupplierInvoiceAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page" testId="supplier-invoice-notice-page">
    <ShellHeader eyebrow={notice.propertyName ?? t("company")} title={t("emergencyNoticeTitle")} subtitle={t("emergencyNoticeDescription")}
      actions={<Link className="secondary-button" href={`/${locale}/app/notifications`}>{t("backToInbox")}</Link>} />
    <section className="notification-settings"><p dir="auto" data-testid="invoice-notice-purpose">{notice.purpose}</p>
      <dl className="detail-grid"><div><dt>{t("ownerGrossShare")}</dt><dd data-testid="invoice-notice-gross" dir="auto">{formatCurrencyAmount(locale, notice.amount, notice.currency)}</dd></div>
        <div><dt>{t("ownerCostAllocation")}</dt><dd data-testid="invoice-notice-owner-cost" dir="auto">{formatCurrencyAmount(locale, notice.ownerAmount, notice.currency)}</dd></div>
        <div><dt>{t("category")}</dt><dd dir="auto">{notice.category}</dd></div><div><dt>{t("occurredOn")}</dt>
          <dd>{formatDate(locale, new Date(`${notice.occurredOn}T00:00:00Z`), { timeZone: "UTC" })}</dd></div></dl>
    </section>
  </AdminShell>;
}
