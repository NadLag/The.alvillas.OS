import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { ExpenseAccessError, getExpenseEditor } from "@/modules/finance/application/expense-service";
import { ExpenseDraftForm } from "@/modules/finance/ui/expense-form";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";

export const dynamic = "force-dynamic";
export default async function NewExpensePage({ params, searchParams }: { params: Promise<{ locale: string; propertyId: string }>; searchParams: Promise<{ fundingAccountId?: string }> }) {
  const input = await params, locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const { fundingAccountId } = await searchParams;
  const t = await getTranslations("Expenses"),recurring=await getTranslations("RecurringExpenses"); let editor;
  try { editor = await getExpenseEditor(actor, input.propertyId, {}, fundingAccountId); }
  catch (error) { if (error instanceof ExpenseAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  const now=new Date(),base={organizationId:actor.organizationId,dataClass:"financial"as const},canSchedule=authorizeOrganizationSource(actor.authContext,"create",{...base,type:"expense"},now)&&["expense","financial_transaction"].every(type=>authorizeOrganizationSource(actor.authContext,"view",{...base,type},now))&&authorizeOrganizationSource(actor.authContext,"configure",{type:"config_rule",id:"finance.recurring_expenses",organizationId:actor.organizationId},now);
  return <AdminShell className="resource-page expense-page" testId="expense-new-page"><ShellHeader eyebrow={editor.property.name} title={t("new")} subtitle={t("description")}
    actions={<div className="form-actions">{editor.canConfigureAccounts ? <Link className="secondary-button" data-testid="expense-manage-accounts" href={`/${locale}/app/finance/accounts?propertyId=${editor.property.id}`}>{t("manageAccounts")}</Link> : null}
      {canSchedule?<Link className="secondary-button" data-testid="expense-recurring-schedules" href={`/${locale}/app/properties/${editor.property.id}/expenses/recurring`}>{recurring("title")}</Link>:null}
      <Link className="secondary-button" href={`/${locale}/app/properties/${editor.property.id}`}>{t("back")}</Link></div>} /><ExpenseDraftForm editor={editor} fundingAccountId={fundingAccountId} /></AdminShell>;
}
