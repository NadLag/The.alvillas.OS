import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getTranslations,
  getFormatter,
  setRequestLocale,
} from "next-intl/server";
import { ManagerShell, ShellHeader, EmptyState } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationCreationOptions } from "@/modules/reservations/application/operation-service";
import { operationSeriesOptions } from "@/modules/reservations/application/operation-automation";
import { OperationForm } from "@/modules/reservations/ui/operation-form";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { taskPriorities } from "@/modules/reservations/domain/operation-task";
export const dynamic = "force-dynamic";
export default async function RecurringPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ propertyId?: string; series?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) redirect(`/${locale}/login`);
  const query = await searchParams,
    [t, f, options] = await Promise.all([
      getTranslations({ locale, namespace: "Operations.manage" }),
      getFormatter({ locale }),
      operationCreationOptions(ctx, query.propertyId),
    ]),
    model = options.propertyId
      ? await operationSeriesOptions(ctx, options.propertyId)
      : null,
    selected = model?.series.find((s) => s.key === query.series),
    start = selected?.start_minute;
  return (
    <ManagerShell className="resource-page" testId="operations-series-page">
      <ShellHeader
        title={t("recurringTitle")}
        subtitle={t("seriesHelp")}
        eyebrow={t("eyebrow")}
        actions={
          <Link className="secondary-button" href={`/${locale}/app/operations`}>
            {t("back")}
          </Link>
        }
      />
      <section className="workspace-main">
        <form method="get" className="operation-filters">
          <label>
            {t("property")}
            <select name="propertyId" defaultValue={options.propertyId ?? ""}>
              {options.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button" type="submit">
            {t("chooseProperty")}
          </button>
        </form>
        {model ? (
          <ul>
            {model.series.map((s) => (
              <li key={s.key}>
                <Link
                  href={`?propertyId=${options.propertyId}&series=${s.key}`}
                >
                  {localizedText(s.title, locale)}
                </Link>{" "}
                · {s.enabled ? t("seriesEnabled") : t("seriesPaused")}
              </li>
            ))}
          </ul>
        ) : null}
        {options.propertyId && options.checklists.length && model ? (
          <OperationForm
            locale={locale}
            operation="series"
            idempotencyKey={randomUUID()}
            submit={t("saveSeries")}
            key={`${options.propertyId}:${selected?.key ?? "new"}:${model.version}`}
          >
            <input type="hidden" name="propertyId" value={options.propertyId} />
            <input type="hidden" name="expectedVersion" value={model.version} />
            <input
              type="hidden"
              name="seriesKey"
              value={selected?.key ?? randomUUID()}
            />
            <label>
              {t("type")}
              <select name="type" required defaultValue={selected?.type ?? ""}>
                <option value="">{t("chooseType")}</option>
                {taskTypeSchema.options.map((type) => (
                  <option key={type} value={type}>
                    {t(`types.${type}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("titleEn")}
              <input
                name="titleEn"
                required
                maxLength={240}
                defaultValue={selected?.title.en}
              />
            </label>
            <label>
              {t("titleFr")}
              <input
                name="titleFr"
                required
                maxLength={240}
                defaultValue={selected?.title.fr}
              />
            </label>
            <label>
              {t("checklist")}
              <select
                name="checklistTemplateKey"
                defaultValue={selected?.checklist_template_key}
              >
                {options.checklists.map((c) => (
                  <option key={c.key} value={c.key}>
                    {localizedText(c.name, locale)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("from")}
              <input
                name="startsOn"
                type="date"
                required
                defaultValue={selected?.starts_on}
              />
            </label>
            <label>
              {t("seriesEnd")}
              <input
                name="endsOn"
                type="date"
                defaultValue={selected?.ends_on ?? ""}
              />
            </label>
            <label>
              {t("everyDays")}
              <input
                name="everyDays"
                type="number"
                min={1}
                max={366}
                required
                defaultValue={selected?.every_days}
              />
            </label>
            <fieldset>
              <legend>{t("weekdays")}</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <label className="field-checklist-item" key={day}>
                  <input
                    type="checkbox"
                    name="weekdays"
                    value={day}
                    defaultChecked={selected?.weekdays.includes(day)}
                  />
                  {f.dateTime(new Date(Date.UTC(2027, 0, 3 + day)), {
                    weekday: "long",
                    timeZone: "UTC",
                  })}
                </label>
              ))}
            </fieldset>
            <label>
              {t("startMinute")}
              <input
                type="time"
                name="startTime"
                required
                defaultValue={
                  start === undefined
                    ? undefined
                    : `${Math.floor(start / 60)
                        .toString()
                        .padStart(
                          2,
                          "0",
                        )}:${(start % 60).toString().padStart(2, "0")}`
                }
              />
            </label>
            <label>
              {t("priority")}
              <select
                name="priority"
                defaultValue={selected?.priority ?? "NORMAL"}
              >
                {taskPriorities.map((p) => (
                  <option key={p} value={p}>
                    {t(`priorities.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-checklist-item">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={selected?.enabled ?? true}
              />
              {t("seriesEnabled")}
            </label>
            <label className="field-checklist-item">
              <input type="checkbox" name="cancelFuture" />
              {t("cancelFuture")}
            </label>
          </OperationForm>
        ) : (
          <EmptyState>{t("missingChecklist")}</EmptyState>
        )}
      </section>
    </ManagerShell>
  );
}
