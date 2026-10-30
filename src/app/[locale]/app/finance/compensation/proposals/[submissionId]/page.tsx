import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationCostDetail } from "@/modules/finance/ui/compensation-cost-detail";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;submissionId:string}>;searchParams:Promise<{after?:string}>}){
  const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);await requireCompensationSession(locale);
  const [t,query]=await Promise.all([getTranslations("CompensationCosts"),searchParams]),parsed=z.object({submissionId:z.uuid(),after:z.uuid().optional()}).strict().safeParse({...query,submissionId:values.submissionId});if(!parsed.success)notFound();
  return <AdminShell className="resource-page compensation-page" testId="compensation-cost-detail-page"><ShellHeader eyebrow={t("eyebrow")} title={t("detailTitle")} subtitle={t("detailGuidance")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation`} prefetch={false}>{t("backRuns")}</Link>}/><CompensationCostDetail key={parsed.data.submissionId} locale={locale} submissionId={parsed.data.submissionId} after={parsed.data.after}/></AdminShell>;
}
