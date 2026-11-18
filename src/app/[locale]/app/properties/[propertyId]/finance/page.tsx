import Link from "next/link";
import {notFound} from "next/navigation";
import {z} from "zod";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {authorizeCollection} from "@/platform/authz/authorize";
import {safeLocale} from "@/i18n/routing";
import {requireCompensationSession} from "@/modules/finance/ui/compensation-access";
import {PropertyFinanceWorkspace} from "@/modules/finance/ui/property-finance-workspace";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;propertyId:string}>}){
 const input=await params,locale=safeLocale(input.locale),id=z.uuid().safeParse(input.propertyId);if(!id.success)notFound();setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("PropertyFinance"),scope=actor.organizationId+"."+actor.actorId, reports=await getTranslations("PerformanceReports");
 return <AdminShell className="resource-page compensation-page property-finance-page" testId="property-finance-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<>
    <Link className="secondary-button" href={`/${locale}/app/properties/${id.data}`}>{t("back")}</Link>
    {authorizeCollection(actor.authContext,"view","report") ? <Link className="secondary-button" href={`/${locale}/app/properties/${id.data}/reports`}>{reports("propertyTitle")}</Link> : null}
  </>}/><PropertyFinanceWorkspace key={scope+"."+id.data} propertyId={id.data} locale={locale}/></AdminShell>;
}
