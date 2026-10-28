import "server-only";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "../application/finance-access";
import { assertCompanyLedgerAccess, CompanyLedgerAccessError } from "../application/company-ledger-service";

export async function companyLedgerActor(locale: string) {
  const actor = await financeActorContextFromSession(await auth());
  if (!actor) redirect(`/${locale}/login`);
  return actor;
}
export async function requireCompanyLedgerAccess(locale: string) {
  const actor = await companyLedgerActor(locale);
  try { await assertCompanyLedgerAccess(actor); }
  catch (error) { if (error instanceof CompanyLedgerAccessError) notFound(); throw error; }
}
