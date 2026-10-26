import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { ExpenseAccessError, getExpenseEditor } from "@/modules/finance/application/expense-service";
import { ExpenseDraftForm } from "@/modules/finance/ui/expense-form";

export const dynamic = "force-dynamic";
export default async function NewExpensePage({ params }: { params: Promise<{ locale: string; propertyId: string }> }) {
  const input = await params, locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("Expenses"); let editor;
  try { editor = await getExpenseEditor(actor, input.propertyId); }
  catch (error) { if (error instanceof ExpenseAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page expense-page" testId="expense-new-page"><ShellHeader eyebrow={editor.property.name} title={t("new")} subtitle={t("description")}
    actions={<Link className="secondary-button" href={`/${locale}/app/properties/${editor.property.id}`}>{t("back")}</Link>} /><ExpenseDraftForm editor={editor} /></AdminShell>;
}
