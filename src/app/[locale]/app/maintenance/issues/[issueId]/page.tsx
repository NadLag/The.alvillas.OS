import Link from "next/link";
import {notFound,redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {assertMaintenanceIssueViewer} from "@/modules/maintenance/application/issue-read-service";
import {MaintenanceIssueAccessError} from "@/modules/maintenance/domain/issue-context";
import {MaintenanceIssueManager} from "@/modules/maintenance/ui/issue-manager";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;issueId:string}>}){
 const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);
 const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");
 const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 const issue=z.uuid().transform(value=>value.toLowerCase()).safeParse(values.issueId);if(!issue.success)notFound();
 try{await assertMaintenanceIssueViewer(actor,{issueId:issue.data});}catch(error){if(error instanceof MaintenanceIssueAccessError)notFound();throw error;}
 const t=await getTranslations("MaintenanceIssues"),scope=actor.organizationId+"."+actor.actorId;
 return <AdminShell className="resource-page maintenance-page" testId="maintenance-issue-page">
  <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link prefetch={false} className="secondary-button" href={"/"+locale+"/app/operations"}>{t("backToOperations")}</Link>}/>
  <MaintenanceIssueManager key={scope+":"+issue.data+":"+locale} locale={locale} authorizationScope={scope} issueId={issue.data}/>
 </AdminShell>;
}
