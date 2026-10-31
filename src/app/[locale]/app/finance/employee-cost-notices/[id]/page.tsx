import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { EmployeeCompensationNotice } from "@/modules/finance/ui/employee-compensation-notice";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;id:string}>}){
  const input=await params,locale=safeLocale(input.locale);setRequestLocale(locale);await requireCompensationSession(locale);const id=z.uuid().safeParse(input.id);if(!id.success)notFound();
  const t=await getTranslations("EmployeeCostNotices");
  return <AdminShell className="resource-page compensation-page" testId="employee-cost-owner-notice-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app/notifications`} prefetch={false}>{t("back")}</Link>}/><EmployeeCompensationNotice key={id.data} locale={locale} id={id.data}/></AdminShell>;
}
