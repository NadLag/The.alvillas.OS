import { redirect } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { DocumentArchiveWorkspace } from "@/modules/documents/ui/document-archive-workspace";

export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){
  const locale=safeLocale((await params).locale);setRequestLocale(locale);
  const[session,t]=await Promise.all([auth(),getTranslations("DocumentArchive")]),actor=await accountActorContextFromSession(session);if(!actor)redirect(`/${locale}/login`);
  const scope=actor.organizationId+"."+actor.actorId;
  return <AdminShell className="resource-page attachment-page" testId="document-archive-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")}/><DocumentArchiveWorkspace key={scope} locale={locale} scope={scope}/></AdminShell>;
}
