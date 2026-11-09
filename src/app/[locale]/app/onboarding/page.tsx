import {z} from "zod";
import {redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {OnboardingWorkspace} from "@/modules/onboarding/ui/onboarding-workspace";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const [session,t]=await Promise.all([auth(),getTranslations("OnboardingWizard")]),actor=await accountActorContextFromSession(session);if(!actor)redirect(`/${locale}/login`);const query=await searchParams,sessionId=z.uuid().safeParse(query.session),ownerId=z.uuid().safeParse(query.owner),scope=actor.organizationId+"."+actor.actorId;
 return <AdminShell className="resource-page onboarding-workspace-page" testId="onboarding-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")}/><OnboardingWorkspace key={scope+":"+(sessionId.success?sessionId.data:"")+":"+(ownerId.success?ownerId.data:"")} locale={locale} scope={scope} initialSessionId={sessionId.success?sessionId.data:undefined} initialOwnerId={ownerId.success?ownerId.data:undefined}/></AdminShell>;
}
