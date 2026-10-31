import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationHourlyCreate } from "@/modules/finance/ui/compensation-hourly-create";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("HourlyCompensation"),runs=await getTranslations("CompensationRuns"),scope=actor.organizationId+"."+actor.actorId;return <AdminShell className="resource-page compensation-page" testId="hourly-new-page"><ShellHeader eyebrow={runs("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation`} prefetch={false}>{runs("backRuns")}</Link>}/><CompensationHourlyCreate key={scope} locale={locale} recoveryScope={scope}/></AdminShell>;}
