import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import {
  templateActorFromSession,
  templateCatalog,
  templateVersionHistory,
  propertyTemplateState,
  TemplateAccessError,
  TemplateNotFoundError
} from "@/modules/core/application/property-template-service";
import { templateKinds, templateKindSchema } from "@/modules/core/domain/property-template";
import { TemplateEditor, TemplateApplication } from "@/modules/core/ui/property-template-admin";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";
const scalar = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const pageNumber = (value: string | string[] | undefined) =>
  Math.max(1, Math.min(10000, Number(scalar(value)) || 1));
export default async function TemplatesPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]),
    appLocale = safeLocale(locale);
  setRequestLocale(appLocale);
  const t = await getTranslations("Templates"),
    ctx = await templateActorFromSession(await auth());
  if (!ctx) redirect(`/${appLocale}/login`);
  const kind = templateKindSchema.catch("PROPERTY").parse(scalar(query.kind)),
    targetId = scalar(query.property) ?? "";
  const page = pageNumber(query.page),
    historyPage = pageNumber(query.historyPage),
    versionPage = pageNumber(query.versionPage),
    propertyPage = pageNumber(query.propertyPage);
  const link = (overrides: Record<string, string | number>) => {
    const values = new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) => (scalar(value) ? [[key, scalar(value)!]] : []))
    );
    values.set("kind", kind);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === "") values.delete(key);
      else values.set(key, String(value));
    }
    return `/${appLocale}/app/templates?${values}`;
  };
  let catalog: Awaited<ReturnType<typeof templateCatalog>> = {
    properties: [],
    moreProperties: false,
    templates: [],
    more: false,
    page
  };
  let detail: Awaited<ReturnType<typeof templateVersionHistory>> | null = null;
  let state: Awaited<ReturnType<typeof propertyTemplateState>> | null = null;
  let message: "forbidden" | "notFound" | "generic" | null = null;
  try {
    catalog = await templateCatalog(ctx, {
      kind,
      propertyId: targetId || undefined,
      search: scalar(query.q),
      page,
      propertySearch: scalar(query.propertySearch),
      propertyPage
    });
    const selectedId = scalar(query.template);
    [detail, state] = await Promise.all([
      selectedId ? templateVersionHistory(ctx, selectedId, versionPage, targetId || null) : null,
      targetId ? propertyTemplateState(ctx, targetId, kind, historyPage) : null
    ]);
    if (detail && detail.selected.kind !== kind) throw new TemplateNotFoundError();
  } catch (error) {
    message =
      error instanceof TemplateAccessError
        ? "forbidden"
        : error instanceof TemplateNotFoundError || error instanceof z.ZodError
          ? "notFound"
          : "generic";
  }
  const selected = detail
    ? { ...detail.selected, createdAt: detail.selected.createdAt.toISOString() }
    : undefined;
  const latestVersion = detail?.latestVersion ?? 0;
  const content = message ? (
    <section className="workspace-main" role="alert" data-testid="templates-denied">
      <p>{t(`messages.${message}`)}</p>
      <Link className="secondary-button" href={`/${appLocale}/app/templates`}>
        {t("retry")}
      </Link>
    </section>
  ) : (
    <>
      <nav className="template-tabs" aria-label={t("kindsLabel")}>
        {templateKinds.map((value) => (
          <Link
            key={value}
            href={link({ kind: value, template: "", page: 1, versionPage: 1, historyPage: 1 })}
            aria-current={kind === value ? "page" : undefined}
          >
            {t(`kinds.${value}`)}
          </Link>
        ))}
      </nav>
      <form method="get" className="template-filters">
        <input type="hidden" name="kind" value={kind} />
        <label className="field">
          <span>{t("search")}</span>
          <input name="q" defaultValue={scalar(query.q)} maxLength={160} />
        </label>
        <label className="field">
          <span>{t("propertySearch")}</span>
          <input name="propertySearch" defaultValue={scalar(query.propertySearch)} maxLength={160} />
        </label>
        <label className="field">
          <span>{t("target")}</span>
          <select name="property" defaultValue={targetId} data-testid="template-target">
            <option value="">{t("chooseProperty")}</option>
            {catalog.properties.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button" data-testid="template-filter">
          {t("filter")}
        </button>
      </form>
      {propertyPage > 1 ? (
        <Link href={link({ propertyPage: propertyPage - 1 })}>{t("previousProperties")}</Link>
      ) : null}
      {catalog.moreProperties ? (
        <Link href={link({ propertyPage: propertyPage + 1 })}>{t("moreProperties")}</Link>
      ) : null}
      <div className="template-layout">
        <section className="workspace-main template-catalog">
          <h2>{t("library")}</h2>
          <p>{t("scopeNote")}</p>
          {!catalog.templates.length ? (
            <p className="empty-state" data-testid="template-empty">
              {t("empty")}
            </p>
          ) : (
            <ul className="template-list">
              {catalog.templates.map((row) => (
                <li key={row.id}>
                  <Link
                    href={link({ template: row.id, versionPage: 1 })}
                    data-testid="template-card"
                    aria-current={row.key === detail?.selected.key ? "page" : undefined}
                  >
                    <strong>{localizedText(row.name as Record<string, string>, appLocale)}</strong>
                    <span>
                      {t("version", { version: row.version })} · {t(`statuses.${row.status}`)}
                    </span>
                    <span>
                      {row.propertyId
                        ? (catalog.properties.find((p) => p.id === row.propertyId)?.name ??
                          t("propertyScope"))
                        : t("organizationScope")}
                    </span>
                    {row.restricted ? <span>{t("financialRestricted")}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="template-actions">
            {page > 1 ? <Link href={link({ page: page - 1 })}>{t("previous")}</Link> : null}
            {catalog.more ? <Link href={link({ page: page + 1 })}>{t("next")}</Link> : null}
            <Link className="secondary-button" href={link({ template: "", versionPage: 1 })}>
              {t("create")}
            </Link>
          </div>
          {detail ? (
            <>
              <h3>{t("versionHistory")}</h3>
              <ol className="template-history">
                {detail.versions.map((row) => (
                  <li key={row.id}>
                    <Link href={link({ template: row.id })}>
                      {t("version", { version: row.version })} ·{" "}
                      {localizedText(row.name as Record<string, string>, appLocale)}
                    </Link>
                    <p>{row.reason}</p>
                  </li>
                ))}
              </ol>
              {versionPage > 1 ? (
                <Link href={link({ versionPage: versionPage - 1 })}>{t("previous")}</Link>
              ) : null}
              {detail.more ? (
                <Link href={link({ versionPage: versionPage + 1 })}>{t("next")}</Link>
              ) : null}
            </>
          ) : null}
        </section>
        <TemplateEditor
          key={selected?.id ?? `new-${kind}`}
          locale={appLocale}
          kind={kind}
          selected={selected}
          latestVersion={latestVersion}
          properties={catalog.properties}
          targetId={targetId}
        />
      </div>
      {state && targetId ? (
        <TemplateApplication
          key={`${targetId}-${kind}-${state.binding?.revision ?? 0}-${selected?.id ?? ""}`}
          locale={appLocale}
          propertyId={targetId}
          kind={kind}
          state={state}
          selected={selected}
        />
      ) : (
        <section className="workspace-main">
          <p>{t("chooseTargetNote")}</p>
        </section>
      )}
      {historyPage > 1 ? (
        <Link href={link({ historyPage: historyPage - 1 })}>{t("previous")}</Link>
      ) : null}
      {state?.more ? <Link href={link({ historyPage: historyPage + 1 })}>{t("next")}</Link> : null}
    </>
  );
  return (
    <AdminShell className="resource-page" testId="templates-page">
      <ShellHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("back")}
          </Link>
        }
      />
      {content}
    </AdminShell>
  );
}
