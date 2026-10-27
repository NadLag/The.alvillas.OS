import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { assertAccountingPeriodViewer } from "@/modules/finance/application/accounting-period-service";
import { AccountingPeriodAccessError } from "@/modules/finance/domain/accounting-period";

export default async function AccountingPeriodsLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params, actor = await financeActorContextFromSession(await auth());
  if (!actor) redirect(`/${safeLocale(locale)}/login`);
  try { await assertAccountingPeriodViewer(actor); }
  catch (error) { if (error instanceof AccountingPeriodAccessError) notFound(); throw error; }
  return children;
}
