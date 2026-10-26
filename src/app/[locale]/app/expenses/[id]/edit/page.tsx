import Link from "next/link";
import { notFound,redirect } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { ExpenseAccessError,ExpenseConflictError,getExpenseDraftEditor } from "@/modules/finance/application/expense-service";
import { ExpenseDraftForm } from "@/modules/finance/ui/expense-form";

export const dynamic="force-dynamic";
export default async function EditExpensePage({params}:{params:Promise<{locale:string;id:string}>}){
  const input=await params,locale=safeLocale(input.locale);setRequestLocale(locale);
  const actor=await financeActorContextFromSession(await auth());if(!actor)redirect(`/${locale}/login`);
  const t=await getTranslations("Expenses");let data;
  try{data=await getExpenseDraftEditor(actor,input.id);}
  catch(error){if(error instanceof ExpenseAccessError||error instanceof Error&&error.name==="ZodError")notFound();
    if(error instanceof ExpenseConflictError)redirect(`/${locale}/app/expenses/${input.id}`);throw error;}
  return <AdminShell className="resource-page expense-page" testId="expense-edit-page"><ShellHeader eyebrow={data.editor.property.name} title={t("editDraft")} subtitle={t("description")}
    actions={<Link className="secondary-button" href={`/${locale}/app/expenses/${data.draft.id}`}>{t("backToExpense")}</Link>}/><ExpenseDraftForm editor={data.editor} draft={data.draft}/></AdminShell>;
}
