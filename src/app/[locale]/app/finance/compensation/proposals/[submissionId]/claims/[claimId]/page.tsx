import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { employeeCompensationClaimDetailInput } from "@/modules/finance/domain/employee-compensation-claim-workspace";
import { CompensationClaimDetail } from "@/modules/finance/ui/compensation-claim-detail";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;submissionId:string;claimId:string}>;searchParams:Promise<{after?:string;beforeRequest?:string}>}){
  const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),query=await searchParams,parsed=employeeCompensationClaimDetailInput.safeParse({...query,id:values.submissionId,claimId:values.claimId});if(!parsed.success)notFound();
  const t=await getTranslations("CompensationClaims"),scope=actor.organizationId+"."+actor.actorId+"."+parsed.data.id+"."+parsed.data.claimId;
  return <AdminShell className="resource-page compensation-page" testId="compensation-claim-page"><ShellHeader eyebrow={t("eyebrow")} title={t("detailTitle")} subtitle={t("detailGuidance")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${parsed.data.id}/claims`} prefetch={false}>{t("backClaims")}</Link>}/><CompensationClaimDetail key={scope} locale={locale} submissionId={parsed.data.id} claimId={parsed.data.claimId} recoveryScope={scope} after={parsed.data.after} beforeRequest={parsed.data.beforeRequest}/></AdminShell>;
}
