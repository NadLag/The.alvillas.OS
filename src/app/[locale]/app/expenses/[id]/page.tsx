import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDate } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { ExpenseAccessError, getExpense } from "@/modules/finance/application/expense-service";
import { ExpenseSubmissionForm,ExpensePostingForm,ExpenseVoidForm } from "@/modules/finance/ui/expense-form";

export const dynamic = "force-dynamic";
export default async function ExpensePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const input = await params, locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("Expenses"); let expense;
  try { expense = await getExpense(actor, input.id); }
  catch (error) { if (error instanceof ExpenseAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page expense-page" testId="expense-detail-page"><ShellHeader eyebrow={expense.propertyName} title={expense.purpose} subtitle={t("description")}
    actions={<div className="form-actions">{expense.canSubmit?<Link className="secondary-button" data-testid="expense-edit" href={`/${locale}/app/expenses/${expense.id}/edit`}>{t("editDraft")}</Link>:null}
      <Link className="secondary-button" href={`/${locale}/app/properties/${expense.propertyId}`}>{t("back")}</Link></div>} />
    <section className="notification-settings"><p data-testid="expense-state" role="status">{t(`states.${expense.state}`)}</p>
      {expense.emergencyException?<p role="status" data-testid="expense-emergency-notice">{t("emergencyException")}</p>:null}
      <dl className="detail-grid"><div><dt>{t("amount")}</dt><dd data-testid="expense-total" dir="auto">{formatCurrencyAmount(locale, expense.amount, expense.currency)}</dd></div>
        <div><dt>{t("category")}</dt><dd>{expense.category}</dd></div><div><dt>{t("occurredOn")}</dt><dd>{formatDate(locale, new Date(`${expense.occurredOn}T00:00:00Z`), { timeZone: "UTC" })}</dd></div></dl>
      {expense.approvalId ? <Link className="secondary-button" data-testid="expense-approval-link" href={`/${locale}/app/approvals/${expense.approvalId}`}>{t("viewApproval")}</Link> : null}
      {expense.canSubmit ? <ExpenseSubmissionForm expense={expense} /> :expense.canPost?<ExpensePostingForm expense={expense}/>:expense.canVoid?<ExpenseVoidForm expense={expense}/>:<p>{t(expense.state==="VOIDED"?"voidedGuidance":"submittedGuidance")}</p>}
    </section>
  </AdminShell>;
}
