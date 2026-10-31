import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationMonthlyCreate } from "@/modules/finance/ui/compensation-monthly-create";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("MonthlyCompensation"),runs=await getTranslations("CompensationRuns"),scope=actor.organizationId+"."+actor.actorId;return <AdminShell className="resource-page compensation-page" testId="monthly-new-page"><ShellHeader eyebrow={runs("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation`} prefetch={false}>{runs("backRuns")}</Link>}/><CompensationMonthlyCreate key={scope} locale={locale} recoveryScope={scope}/></AdminShell>;}
