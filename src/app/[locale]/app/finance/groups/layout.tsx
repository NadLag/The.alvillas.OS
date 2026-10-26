import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { assertTransactionGroupViewer, TransactionGroupAccessError } from "@/modules/finance/application/transaction-group-service";

// Resolve authorization above this segment's loading boundary so a denied
// request receives its 404 before any streaming response begins. Pages and
// actions still reload current grants independently.
export default async function TransactionGroupsLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params, actor = await financeActorContextFromSession(await auth());
  if (!actor) redirect(`/${safeLocale(locale)}/login`);
  try { await assertTransactionGroupViewer(actor); }
  catch (error) { if (error instanceof TransactionGroupAccessError) notFound(); throw error; }
  return children;
}
