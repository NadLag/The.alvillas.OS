import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { employeeCompensationClaimWorkspaceInput } from "@/modules/finance/domain/employee-compensation-claim-workspace";
import { CompensationClaimList } from "@/modules/finance/ui/compensation-claim-list";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;submissionId:string}>;searchParams:Promise<{after?:string}>}){
  const values=await params,locale=safeLocale(values.locale);setRequestLocale(locale);const actor=await requireCompensationSession(locale),query=await searchParams,parsed=employeeCompensationClaimWorkspaceInput.safeParse({...query,id:values.submissionId});if(!parsed.success)notFound();
  const t=await getTranslations("CompensationClaims"),scope=actor.organizationId+"."+actor.actorId+"."+parsed.data.id;
  return <AdminShell className="resource-page compensation-page" testId="compensation-claims-page"><ShellHeader eyebrow={t("eyebrow")} title={t("listTitle")} subtitle={t("listGuidance")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${parsed.data.id}`} prefetch={false}>{t("backProposal")}</Link>}/><CompensationClaimList key={scope} locale={locale} submissionId={parsed.data.id} after={parsed.data.after}/></AdminShell>;
}
