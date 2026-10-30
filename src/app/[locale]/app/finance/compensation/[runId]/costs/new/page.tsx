import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationCostCreate } from "@/modules/finance/ui/compensation-cost-create";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;runId:string}>}){
  const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),id=z.uuid().safeParse(values.runId);if(!id.success)notFound();
  const t=await getTranslations("CompensationCosts"),scope=actor.organizationId+"."+actor.actorId+"."+id.data;
  return <AdminShell className="resource-page compensation-page" testId="compensation-cost-new-page"><ShellHeader eyebrow={t("eyebrow")} title={t("prepare")} subtitle={t("prepareDescription")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation/${id.data}/costs`} prefetch={false}>{t("backCosts")}</Link>}/><CompensationCostCreate key={scope} locale={locale} runId={id.data} recoveryScope={scope}/></AdminShell>;
}
