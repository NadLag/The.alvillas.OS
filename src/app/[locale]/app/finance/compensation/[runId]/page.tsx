import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationRunDetail } from "@/modules/finance/ui/compensation-run-detail";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;runId:string}>;searchParams:Promise<{after?:string}>}){
  const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);await requireCompensationSession(locale);
  const [t,query]=await Promise.all([getTranslations("CompensationRuns"),searchParams]);
  const parsed=z.object({runId:z.uuid(),after:z.uuid().optional()}).strict().safeParse({...query,runId:values.runId});if(!parsed.success)notFound();
  return <AdminShell className="resource-page compensation-page" testId="compensation-detail-page"><ShellHeader eyebrow={t("eyebrow")} title={t("detailTitle")} subtitle={t("detailDescription")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation`} prefetch={false}>{t("backRuns")}</Link>}/><CompensationRunDetail key={values.runId} locale={locale} runId={parsed.data.runId} after={parsed.data.after}/></AdminShell>;
}
