import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { listAssets } from "@/modules/assets/application/asset-service";
import { assetSearchSchema } from "@/modules/assets/domain/asset";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { z } from "zod";

export default async function AssetListPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const [{ locale }, query, session] = await Promise.all([params, searchParams, auth()]);
  const actor = await accountActorContextFromSession(session);
  if (!actor?.authContext.permissions.has("asset:view")) notFound();
  const selected = assetSearchSchema.extend({ cursor: z.uuid().optional() }).safeParse({ query: query.q, cursor: query.cursor });
  if (!selected.success) notFound();
  const [t, assets] = await Promise.all([getTranslations("Assets"), listAssets(actor, selected.data)]);
  const base = "/" + safeLocale(locale) + "/app/assets";
  return <AdminShell className="resource-page" testId="asset-register">
    <ShellHeader eyebrow={""} title={t("title")} actions={actor.authContext.permissions.has("asset:create")
      ? <Link className="primary-button" href={base + "/new"}>{t("create")}</Link> : undefined} />
    <form className="resource-form">
      <label className="field"><span>{t("search")}</span><input type="search" name="q" defaultValue={selected.data.query} maxLength={120} /></label>
      <button type="submit" className="secondary-button">{t("find")}</button>
    </form>
    {assets.items.length ? <ul className="resource-list">{assets.items.map(asset => <li key={asset.id}>
      <Link className="resource-row" href={base + "/" + asset.id}>
        <span><strong dir="auto">{asset.name}</strong><small dir="auto">{asset.tag}{" \u00b7 "}{asset.propertyName}{" \u00b7 "}{asset.category}</small></span>
        <span>{asset.retirement ? t("lifecycle.events." + asset.retirement) : t("conditions." + asset.condition)}</span>
      </Link>
    </li>)}</ul> : <EmptyState>{t("empty")}</EmptyState>}
    {assets.next ? <Link className="secondary-button" href={base + "?" + new URLSearchParams({ q: selected.data.query, cursor: assets.next }).toString()}>{t("next")}</Link> : null}
  </AdminShell>;
}
