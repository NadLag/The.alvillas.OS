import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { AccountantExportWorkspace } from "@/modules/finance/ui/accountant-export-workspace";

export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const [actor, t] = await Promise.all([requireCompensationSession(locale), getTranslations("AccountantExports")]);
  return <AdminShell className="resource-page compensation-page" testId="accountant-export-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} />
    <AccountantExportWorkspace key={actor.organizationId + "." + actor.actorId} locale={locale} /></AdminShell>;
}
