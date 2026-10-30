import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationRunCreate } from "@/modules/finance/ui/compensation-run-create";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){
  const locale=safeLocale((await params).locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("CompensationRuns"),scope=actor.organizationId+"."+actor.actorId;
  return <AdminShell className="resource-page compensation-page" testId="compensation-new-page"><ShellHeader eyebrow={t("eyebrow")} title={t("create")} subtitle={t("createDescription")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation`} prefetch={false}>{t("backRuns")}</Link>}/><CompensationRunCreate key={scope} locale={locale} recoveryScope={scope}/></AdminShell>;
}
