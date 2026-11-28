import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import Link from "next/link";
import {z} from "zod";
import {GroceryExpenseBinding} from "@/modules/services/ui/grocery-expense-binding";
import {ExpensePersonalSettlement} from "@/modules/finance/ui/expense-personal-settlement";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDate, formatDateTime } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { ExpenseAccessError, getExpense } from "@/modules/finance/application/expense-service";
import { ExpenseSubmissionForm,ExpensePostingForm,ExpenseVoidForm } from "@/modules/finance/ui/expense-form";
import { ExpenseCorrectionForm } from "@/modules/finance/ui/expense-correction-form";

export const dynamic = "force-dynamic";
export default async function ExpensePage({ params,searchParams }: { params: Promise<{ locale: string; id: string }>;searchParams:Promise<{groceryOrder?:string}> }) {
  const input = await params, locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const initial=z.uuid().safeParse((await searchParams).groceryOrder),initialOrderId=initial.success?initial.data:undefined,scope=actor.organizationId+"."+actor.actorId;
  const t = await getTranslations("Expenses"); let expense;
  try { expense = await getExpense(actor, input.id); }
  catch (error) { if (error instanceof ExpenseAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page expense-page" testId="expense-detail-page"><ShellHeader eyebrow={expense.propertyName} title={expense.purpose} subtitle={t("description")}
    actions={<div className="form-actions">{expense.canEditDraft?<Link className="secondary-button" data-testid="expense-edit" href={`/${locale}/app/expenses/${expense.id}/edit`}>{t("editDraft")}</Link>:null}
      {expense.state==="POSTED"&&["inventory_movement","inventory_item","inventory_location"].every(type=>authorizeOrganizationSource(actor.authContext,"view",{type,organizationId:actor.organizationId,dataClass:"operational"},new Date()))?<Link className="secondary-button" data-testid="expense-receive-stock" href={`/${locale}/app/inventory/purchases?source=EXPENSE&id=${expense.id}`} prefetch={false}>{(await getTranslations("InventoryPurchases"))("receiveLink")}</Link>:null}
      <Link className="secondary-button" href={`/${locale}/app/properties/${expense.propertyId}`}>{t("back")}</Link></div>} />
    <section className="notification-settings"><p data-testid="expense-state" role="status">{t(`states.${expense.state}`)}</p>
      {expense.emergencyException?<p role="status" data-testid="expense-emergency-notice">{t("emergencyException")}</p>:null}
      {expense.providerRefund?<p role="status" data-testid="expense-refund-guidance">{t("refundAdmissionGuidance")}</p>:null}
      {expense.correctsExpenseId?<p data-testid="expense-correction-source">{t("correctionSource")} <Link href={`/${locale}/app/expenses/${expense.correctsExpenseId}`}>{t("viewOriginalExpense")}</Link></p>:null}
      <dl className="detail-grid"><div><dt>{t("amount")}</dt><dd data-testid="expense-total" dir="auto">{formatCurrencyAmount(locale, expense.amount, expense.currency)}</dd></div>
        <div><dt>{t("category")}</dt><dd>{expense.category}</dd></div><div><dt>{t("occurredOn")}</dt><dd>{formatDate(locale, new Date(`${expense.occurredOn}T00:00:00Z`), { timeZone: "UTC" })}</dd></div></dl>
      {expense.approvalId ? <Link className="secondary-button" data-testid="expense-approval-link" href={`/${locale}/app/approvals/${expense.approvalId}`}>{t("viewApproval")}</Link> : null}
      {expense.postingAdjustment?<section aria-label={t("adjustmentTitle")} data-testid="expense-period-adjustment"><h2>{t("adjustmentTitle")}</h2>
        <p>{t("adjustmentSourcePeriod",{month:formatDate(locale,new Date(`${expense.postingAdjustment.sourceMonth}-01T00:00:00Z`),{dateStyle:undefined,month:"long",year:"numeric",timeZone:"UTC"})})}</p>
        <p>{t("adjustmentPostedAt",{date:formatDateTime(locale,new Date(expense.postingAdjustment.postedAt),{timeZone:"UTC"}),timezone:"UTC"})}</p>
        <p dir="auto">{expense.postingAdjustment.reason}</p></section>:null}
      {expense.sourcePeriodClosed&&!expense.canPost?<p role="status" data-testid="expense-source-period-closed">{t("periodClosed")}</p>:null}
      {expense.canSubmit ? <ExpenseSubmissionForm expense={expense} /> :expense.canPost?<ExpensePostingForm expense={expense}/>:expense.canVoid?<ExpenseVoidForm expense={expense}/>:<p>{t(expense.state==="VOIDED"?"voidedGuidance":"submittedGuidance")}</p>}
      {expense.canCorrect?<ExpenseCorrectionForm expense={expense}/>:null}
    </section>
    {expense.purchase&&expense.state!=="DRAFT"&&expense.state!=="PENDING_APPROVAL"&&expense.state!=="APPROVED"?<GroceryExpenseBinding key={scope+expense.id} locale={locale} scope={scope} expenseId={expense.id} propertyId={expense.propertyId} initialOrderId={initialOrderId}/>:null}
    {expense.purchase?.fundingKind==="PERSONAL"&&["POSTED","VOIDED"].includes(expense.state)?<ExpensePersonalSettlement key={scope+expense.id+".personal"} scope={scope} expenseId={expense.id} propertyId={expense.propertyId}/>:null}
  </AdminShell>;
}
