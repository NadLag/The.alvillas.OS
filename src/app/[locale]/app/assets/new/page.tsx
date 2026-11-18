import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { listAssetProperties } from "@/modules/assets/application/asset-service";
import { AssetForm } from "@/modules/assets/ui/asset-form";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";

const search = z.object({ q: z.string().max(120).default(""), cursor: z.uuid().optional() });
export default async function NewAssetPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const [{ locale }, raw, session] = await Promise.all([params, searchParams, auth()]);
  const actor = await accountActorContextFromSession(session);
  const parsed = search.safeParse(raw);
  if (!actor?.authContext.permissions.has("asset:create") || !parsed.success) notFound();
  const { q, cursor } = parsed.data;
  const [t, properties] = await Promise.all([getTranslations("Assets"), listAssetProperties(actor, { query: q, cursor })]);
  const appLocale = safeLocale(locale), base = "/" + appLocale + "/app/assets";
  return <AdminShell className="resource-page">
    <ShellHeader eyebrow={t("title")} title={t("create")} actions={<Link className="secondary-button" href={base}>{t("back")}</Link>} />
    <form className="resource-form">
      <label className="field"><span>{t("searchProperty")}</span><input type="search" name="q" defaultValue={q} maxLength={120} /></label>
      <button type="submit" className="secondary-button">{t("find")}</button>
    </form>
    {properties.next ? <Link className="secondary-button" href={base + "/new?" + new URLSearchParams({q, cursor: properties.next})}>{t("nextProperties")}</Link> : null}
    {properties.items.length ? <AssetForm locale={appLocale} properties={properties.items} /> : <EmptyState>{t("noProperties")}</EmptyState>}
  </AdminShell>;
}
