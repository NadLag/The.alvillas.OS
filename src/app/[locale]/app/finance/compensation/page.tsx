import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { CompensationRunList } from "@/modules/finance/ui/compensation-run-list";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{q?:string;state?:string;after?:string}>}){
  const locale=safeLocale((await params).locale);setRequestLocale(locale);
  await requireCompensationSession(locale);
  const [t,raw]=await Promise.all([getTranslations("CompensationRuns"),searchParams]);
  const parsed=z.object({q:z.string().max(160).default(""),state:z.enum(["all","draft","cancelled"]).default("all"),after:z.string().min(1).max(4096).optional()}).strict().safeParse(raw);
  if(!parsed.success)notFound();
  return <AdminShell className="resource-page compensation-page" testId="compensation-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("backWorkspace")}</Link>}/><CompensationRunList locale={locale} query={parsed.data.q} state={parsed.data.state} after={parsed.data.after}/></AdminShell>;
}
