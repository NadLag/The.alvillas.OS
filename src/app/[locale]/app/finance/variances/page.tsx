import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { VarianceCenter } from "@/modules/finance/ui/variance-center";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const [actor, t] = await Promise.all([requireCompensationSession(locale), getTranslations("VarianceCenter")]);
  return <AdminShell className="resource-page compensation-page variance-center-page" testId="variance-center-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("browseGuidance")}/>
    <VarianceCenter key={actor.organizationId + "." + actor.actorId} locale={locale} actorId={actor.actorId}/></AdminShell>;
}
