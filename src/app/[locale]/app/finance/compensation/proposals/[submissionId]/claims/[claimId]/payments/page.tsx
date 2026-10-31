import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { employeeCompensationPaymentWorkspaceInput } from "@/modules/finance/domain/employee-compensation-payment-workspace";
import { CompensationPayments } from "@/modules/finance/ui/compensation-payments";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;submissionId:string;claimId:string}>}){
 const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),parsed=employeeCompensationPaymentWorkspaceInput.safeParse({id:values.submissionId,claimId:values.claimId});if(!parsed.success)notFound();
 const t=await getTranslations("CompensationPayments"),scope=actor.organizationId+"."+actor.actorId+"."+parsed.data.id+"."+parsed.data.claimId;
 return <AdminShell className="resource-page compensation-page" testId="compensation-payments-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${parsed.data.id}/claims/${parsed.data.claimId}`} prefetch={false}>{t("backClaim")}</Link>}/><CompensationPayments key={scope} locale={locale} submissionId={parsed.data.id} claimId={parsed.data.claimId} recoveryScope={scope}/></AdminShell>;
}
