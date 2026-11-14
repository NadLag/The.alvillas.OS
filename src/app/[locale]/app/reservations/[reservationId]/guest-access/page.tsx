import {notFound,redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {safeLocale} from "@/i18n/routing";
import {ManagerShell,ShellHeader} from "@/design-system/shells";
import {guestHubIdSchema} from "@/modules/guest-hub/domain/guest-hub-contract";
import {GuestHubManager} from "@/modules/guest-hub/ui/guest-hub-manager";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;reservationId:string}>}){const input=await params,locale=safeLocale(input.locale),id=guestHubIdSchema.safeParse(input.reservationId);setRequestLocale(locale);const actor=await accountActorContextFromSession(await auth());if(!actor)redirect("/"+locale+"/login");if(!id.success)notFound();const t=await getTranslations("GuestLinkManagement"),scope=actor.organizationId+"."+actor.actorId;return <ManagerShell className="resource-page guest-link-management-page" testId="guest-link-management-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")}/><GuestHubManager key={scope+":"+id.data} locale={locale} scope={scope} reservationId={id.data}/></ManagerShell>;}
