import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { BankStatementWorkspace } from "@/modules/finance/ui/bank-statement-workspace";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const actor = await requireCompensationSession(locale), t = await getTranslations("BankStatements"), scope = actor.organizationId + "." + actor.actorId;
  return <AdminShell className="resource-page compensation-page bank-statement-page" testId="bank-statement-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<><Link className="secondary-button" href={`/${locale}/app/finance/bank-reconciliation`} prefetch={false} data-testid="bank-reconciliation-link">{(await getTranslations("BankReconciliation"))("title")}</Link><Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link></>}/><BankStatementWorkspace key={scope} locale={locale} scope={scope}/></AdminShell>;
}
