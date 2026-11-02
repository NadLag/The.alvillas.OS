import Link from "next/link";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {requireCompensationSession} from "@/modules/finance/ui/compensation-access";
import {CompanyExpenseWorkspace} from "@/modules/finance/ui/company-expense-workspace";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("CompanyExpenses"),scope=actor.organizationId+"."+actor.actorId;
 return <AdminShell className="resource-page compensation-page company-expense-page" testId="company-expense-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>}/><CompanyExpenseWorkspace key={scope} locale={locale} scope={scope}/></AdminShell>;
}
