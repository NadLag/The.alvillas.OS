import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
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
  const appLocale = safeLocale(locale), base = "/" + appLocale + "/app/assets";
  const { asset, history, next } = data;
  const date = (day: string) => formatDate(appLocale, new Date(day), { timeZone: "UTC" });
  const amount = (cost: typeof asset.cost) => typeof cost === "string" ? cost : cost ? formatCurrencyAmount(appLocale, cost.amount, cost.currency) : t("notRecorded");
  return <AdminShell className="resource-page" testId="asset-detail">
    <ShellHeader eyebrow={t("title")} title={asset.name} subtitle={asset.tag + " ? " + asset.propertyName}
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
    <section aria-label={t("history")}>
      <h2>{t("history")}</h2>
      <ol className="resource-list">{history.map(revision => <li key={revision.number} className="resource-form">
        <h3>{t("revision", { number: revision.number })}</h3><p dir="auto">{revision.name} ? {revision.category}</p>
        <p>{t("conditions." + revision.condition)} ? {formatDateTime(appLocale, new Date(revision.updatedAt), { timeZone: "UTC" })}</p>
        <p dir="auto">{revision.reason}</p><p className="money">{amount(revision.cost)}</p>
      </li>)}</ol>
      {next ? <Link className="secondary-button" href={base + "/" + asset.id + "?before=" + next}>{t("older")}</Link> : null}
    </section>
  </AdminShell>;
}
