import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { readAssetPreventiveSchedule } from "@/modules/assets/application/preventive-schedule";
import { AssetPreventiveEditor } from "@/modules/assets/ui/asset-preventive-editor";
import { localizedText } from "@/i18n/content";
import { formatCurrencyAmount, formatDate, formatDateTime } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { getAsset } from "@/modules/assets/application/asset-service";
import { AssetAccessError } from "@/modules/assets/domain/asset";
import { AssetForm } from "@/modules/assets/ui/asset-form";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";

export default async function AssetDetailPage({ params, searchParams }: {
  params: Promise<{ locale: string; assetId: string }>; searchParams: Promise<{ before?: string }>;
}) {
  const [{ locale, assetId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const actor = await accountActorContextFromSession(session);
  const parsed = z.object({ assetId: z.uuid(), before: z.coerce.number().int().positive().optional() }).safeParse({ assetId, before: query.before });
  if (!actor || !parsed.success) notFound();
  const [t, data] = await Promise.all([getTranslations("Assets"), getAsset(actor, parsed.data).catch((error: unknown) => {
    if (error instanceof AssetAccessError) notFound();
    throw error;
  })]);
  const [preventive, operations] = await Promise.all([
    readAssetPreventiveSchedule(actor, parsed.data.assetId).catch((error: unknown) => {
      if (error instanceof AssetAccessError) return null;
      throw error;
    }),
    getTranslations("Operations.manage")
  ]);
  const appLocale = safeLocale(locale), base = "/" + appLocale + "/app/assets";
  const { asset, history, next } = data;
  const date = (day: string) => formatDate(appLocale, new Date(day), { timeZone: "UTC" });
  const amount = (cost: typeof asset.cost) => typeof cost === "string" ? cost : cost ? formatCurrencyAmount(appLocale, cost.amount, cost.currency) : t("notRecorded");
  return <AdminShell className="resource-page" testId="asset-detail">
    <ShellHeader eyebrow={t("title")} title={asset.name} subtitle={asset.tag + " \u00b7 " + asset.propertyName}
      actions={<Link className="secondary-button" href={base}>{t("back")}</Link>} />
    <section className="panel">
      <p dir="auto">{asset.description}</p>
      <dl className="detail-grid">
        <div><dt>{t("category")}</dt><dd dir="auto">{asset.category}</dd></div>
        <div><dt>{t("condition")}</dt><dd>{t("conditions." + asset.condition)}</dd></div>
        <div><dt>{t("purchaseOn")}</dt><dd>{asset.purchaseOn ? date(asset.purchaseOn) : t("notRecorded")}</dd></div>
        <div><dt>{t("cost")}</dt><dd className="money">{amount(asset.cost)}</dd></div>
        <div><dt>{t("warrantyProvider")}</dt><dd dir="auto">{asset.warrantyProvider ?? t("notRecorded")}</dd></div>
        <div><dt>{t("warrantyReference")}</dt><dd dir="auto">{asset.warrantyReference ?? t("notRecorded")}</dd></div>
        <div><dt>{t("warrantyStartsOn")}</dt><dd>{asset.warrantyStartsOn ? date(asset.warrantyStartsOn) : t("notRecorded")}</dd></div>
        <div><dt>{t("warrantyEndsOn")}</dt><dd>{asset.warrantyEndsOn ? date(asset.warrantyEndsOn) : t("notRecorded")}</dd></div>
        <div><dt>{t("life")}</dt><dd>{asset.usefulLifeMonths == null ? t("notRecorded") : new Intl.NumberFormat(appLocale).format(asset.usefulLifeMonths)}</dd></div>
      </dl>
    </section>
    {asset.canEdit ? <AssetForm key={asset.number} locale={appLocale} asset={{
      id: asset.id, number: asset.number, canEditCost: asset.canEditCost,
      fields: { name: asset.name, category: asset.category, condition: asset.condition, description: asset.description,
        purchaseOn: asset.purchaseOn, warrantyProvider: asset.warrantyProvider, warrantyReference: asset.warrantyReference,
        warrantyStartsOn: asset.warrantyStartsOn, warrantyEndsOn: asset.warrantyEndsOn, usefulLifeMonths: asset.usefulLifeMonths,
        ...(typeof asset.cost === "string" ? {} : { cost: asset.cost }) }
    }} /> : null}
    {preventive ? <section className="panel resource-form" aria-label={t("schedule.title")}>
      <h2>{t("schedule.title")}</h2>
      {preventive.schedule ? <>
        <p dir="auto">{localizedText(preventive.schedule.title, appLocale)}</p>
        <p>{t(preventive.schedule.enabled ? "schedule.enabled" : "schedule.paused")}</p>
      </> : <p>{t("schedule.empty")}</p>}
      {preventive.canEdit ? <AssetPreventiveEditor key={preventive.version} assetId={asset.id} locale={appLocale} data={preventive} /> : null}
      {preventive.tasks.length ? <ul className="resource-list">{preventive.tasks.map(task => <li key={task.id}>
        <Link href={"/" + appLocale + "/app/operations/" + task.id}>
          {date(task.dueDate.toISOString())} {" / "} {operations("states." + task.state)}
        </Link>
      </li>)}</ul> : null}
    </section> : null}
    <section aria-label={t("history")}>
      <h2>{t("history")}</h2>
      <ol className="resource-list">{history.map(revision => <li key={revision.number} className="resource-form">
        <h3>{t("revision", { number: revision.number })}</h3><p dir="auto">{revision.name}{" \u00b7 "}{revision.category}</p>
        <p>{t("conditions." + revision.condition)}{" \u00b7 "}{formatDateTime(appLocale, new Date(revision.updatedAt), { timeZone: "UTC" })}</p>
        <p dir="auto">{revision.reason}</p><p className="money">{amount(revision.cost)}</p>
      </li>)}</ol>
      {next ? <Link className="secondary-button" href={base + "/" + asset.id + "?before=" + next}>{t("older")}</Link> : null}
    </section>
  </AdminShell>;
}
