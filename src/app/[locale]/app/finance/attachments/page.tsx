import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { FinancialAttachmentsWorkspace } from "@/modules/finance/ui/financial-attachments-workspace";

export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ transactionId?: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const [actor, t, query] = await Promise.all([requireCompensationSession(locale), getTranslations("FinancialAttachments"), searchParams]);
  const transaction = z.uuid().safeParse(query.transactionId);
  return <AdminShell className="resource-page supplier-page attachment-page" testId="financial-attachments-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} />
    <FinancialAttachmentsWorkspace key={actor.organizationId + "." + actor.actorId} locale={locale} initialTransactionId={transaction.success ? transaction.data : undefined} /></AdminShell>;
}
