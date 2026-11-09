import Link from "next/link";
import {z} from "zod";
import {redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {LeadWorkspace} from "@/modules/crm/ui/lead-workspace";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const locale=safeLocale((await params).locale);setRequestLocale(locale);const[session,t,analyticsT]=await Promise.all([auth(),getTranslations("LeadWorkspace"),getTranslations("LeadAnalytics")]),actor=await accountActorContextFromSession(session);if(!actor)redirect(`/${locale}/login`);const query=await searchParams,leadId=z.uuid().safeParse(query.lead),scope=actor.organizationId+"."+actor.actorId;
  return <AdminShell className="resource-page lead-workspace-page" testId="lead-workspace-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} actions={<Link className="secondary-button" href={`/${locale}/app/crm/analytics`}>{analyticsT("title")}</Link>}/><LeadWorkspace key={scope+":"+(leadId.success?leadId.data:"")} scope={scope} locale={locale} initialLeadId={leadId.success?leadId.data:undefined}/></AdminShell>;
}
