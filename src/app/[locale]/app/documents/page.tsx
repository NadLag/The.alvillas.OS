import { z } from "zod";
import { redirect } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { DocumentArchiveWorkspace } from "@/modules/documents/ui/document-archive-workspace";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const locale=safeLocale((await params).locale);setRequestLocale(locale);
  const[session,t]=await Promise.all([auth(),getTranslations("DocumentArchive")]),actor=await accountActorContextFromSession(session);if(!actor)redirect(`/${locale}/login`);
  const scope=actor.organizationId+"."+actor.actorId,query=await searchParams,reference=z.object({documentId:z.uuid(),number:z.coerce.number().int().positive().max(2147483646)}).safeParse({documentId:query.document,number:query.version}),initialReference=reference.success?reference.data:undefined;
  return <AdminShell className="resource-page attachment-page document-archive-page" testId="document-archive-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")}/><DocumentArchiveWorkspace key={scope+":"+(initialReference?.documentId??"")+":"+(initialReference?.number??"")} locale={locale} scope={scope} initialReference={initialReference}/></AdminShell>;
}
