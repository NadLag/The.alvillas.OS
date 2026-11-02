import Link from "next/link";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {requireCompensationSession} from "@/modules/finance/ui/compensation-access";
import {RecurringExpenseWorkspace} from "@/modules/finance/ui/recurring-expense-workspace";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;propertyId:string}>}){const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("RecurringExpenses");return <AdminShell className="resource-page compensation-page recurring-expense-page" testId="recurring-expense-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app/properties/${values.propertyId}`}>{t("back")}</Link>}/><RecurringExpenseWorkspace key={`${actor.organizationId}.${actor.actorId}.${values.propertyId}`} propertyId={values.propertyId} locale={locale}/></AdminShell>;}
