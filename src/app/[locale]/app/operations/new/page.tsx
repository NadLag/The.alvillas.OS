import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { ManagerShell, ShellHeader, EmptyState } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationCreationOptions } from "@/modules/reservations/application/operation-service";
import { OperationForm } from "@/modules/reservations/ui/operation-form";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { taskPriorities } from "@/modules/reservations/domain/operation-task";
export const dynamic = "force-dynamic";
export default async function NewTask({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ propertyId?: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth()); if (!ctx) redirect(`/${locale}/login`);
  const [t, options] = await Promise.all([getTranslations("Operations.manage"), operationCreationOptions(ctx, (await searchParams).propertyId)]);
  return <ManagerShell className="resource-page operation-new-page" testId="operation-new-page">
    <ShellHeader title={t("newTask")} subtitle={t("newHelp")} eyebrow={t("eyebrow")} actions={<Link className="secondary-button" href={`/${locale}/app/operations`}>{t("back")}</Link>} />
    <section className="workspace-main">
      <form className="resource-form operation-form" method="get"><label>{t("property")}<select name="propertyId" defaultValue={options.propertyId ?? ""}>{options.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="secondary-button" type="submit">{t("chooseProperty")}</button></form>
      {options.propertyId && options.checklists.length ? <OperationForm idempotencyKey={randomUUID()} locale={locale} operation="create" submit={t("newTask")} key={options.propertyId}>
        <input type="hidden" name="propertyId" value={options.propertyId} />
        <label>{t("type")}<select name="type">{taskTypeSchema.options.map(type => <option key={type} value={type}>{t(`types.${type}`)}</option>)}</select></label>
        <label>{t("titleEn")}<input name="titleEn" required maxLength={500} /></label>
        <label>{t("titleFr")}<input name="titleFr" required maxLength={500} /></label>
        <label>{t("date")}<input type="date" name="dueDate" required /></label>
        <label>{t("priority")}<select name="priority" defaultValue="NORMAL">{taskPriorities.map(p => <option key={p} value={p}>{t(`priorities.${p}`)}</option>)}</select></label>
        <label>{t("checklist")}<select name="checklistTemplateKey">{options.checklists.map(c => <option key={c.key} value={c.key}>{localizedText(c.name, locale)}</option>)}</select></label>
      </OperationForm> : <EmptyState>{t("missingChecklist")} <Link href={`/${locale}/app/configuration`}>{t("configuration")}</Link></EmptyState>}
    </section>
  </ManagerShell>;
}
