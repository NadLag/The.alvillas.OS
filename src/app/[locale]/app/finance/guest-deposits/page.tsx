import Link from "next/link";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {requireCompensationSession} from "@/modules/finance/ui/compensation-access";
import {GuestDepositWorkspace} from "@/modules/finance/ui/guest-deposit-workspace";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),t=await getTranslations("GuestDeposits"),scope=actor.organizationId+"."+actor.actorId;
 return <AdminShell className="resource-page compensation-page guest-deposit-page" testId="guest-deposit-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>}/><GuestDepositWorkspace key={scope} locale={locale} scope={scope}/></AdminShell>;
}
