import type {Metadata} from "next";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {GuestShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {guestHubIdSchema} from "@/modules/guest-hub/domain/guest-hub-contract";
import {GuestHubVisit} from "@/modules/guest-hub/ui/guest-hub-visit";
export const metadata:Metadata={robots:{index:false,follow:false},referrer:"no-referrer"};
export default async function Page({params}:{params:Promise<{locale:string;linkId:string}>}){const input=await params,locale=safeLocale(input.locale),link=guestHubIdSchema.safeParse(input.linkId);setRequestLocale(locale);const t=await getTranslations("GuestAccess");return <GuestShell className="guest-access-page" testId="guest-access-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")}/><GuestHubVisit locale={locale} initialLinkId={link.success?link.data:undefined}/></GuestShell>;}
