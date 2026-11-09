import Link from "next/link";
import {redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {LeadAnalytics} from "@/modules/crm/ui/lead-analytics";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const[session,t]=await Promise.all([auth(),getTranslations("LeadAnalytics")]),actor=await accountActorContextFromSession(session);if(!actor)redirect(`/${locale}/login`);const scope=actor.organizationId+"."+actor.actorId;
 return <AdminShell className="resource-page lead-workspace-page lead-analytics-page" testId="lead-analytics-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} actions={<Link className="secondary-button" href={`/${locale}/app/crm`}>{t("leadWorkspace")}</Link>}/><LeadAnalytics key={scope} scope={scope} locale={locale}/></AdminShell>;
}
