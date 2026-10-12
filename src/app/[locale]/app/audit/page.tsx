import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDateTime } from "@/i18n/format";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  AuditAuthorizationError,
  listAuditRecords,
  parseAuditFilters
} from "@/modules/audit/application/audit-service";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function firstSearchValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function searchValueOrEmpty(value: SearchValue): string {
  return firstSearchValue(value) ?? "";
}

function exportHref(searchParams: Record<string, SearchValue>): string {
  const params = new URLSearchParams();

  for (const key of ["action", "resourceType", "actorId", "requestId", "from", "to"]) {
    const value = searchValueOrEmpty(searchParams[key]);
    if (value) {
      params.set(key, value);
    }
  }

  params.set("limit", "200");

  return `/api/audit/export?${params.toString()}`;
}

function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  return JSON.stringify(value);
}

export default async function AuditPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, SearchValue>>;
}>) {
  const [{ locale }, rawSearchParams] = await Promise.all([params, searchParams]);
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session) {
    redirect(`/${appLocale}/login`);
  }

  const ctx = await identityActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Audit");
  const filters = parseAuditFilters({
    action: firstSearchValue(rawSearchParams.action),
    resourceType: firstSearchValue(rawSearchParams.resourceType),
    actorId: firstSearchValue(rawSearchParams.actorId),
    requestId: firstSearchValue(rawSearchParams.requestId),
    from: firstSearchValue(rawSearchParams.from),
    to: firstSearchValue(rawSearchParams.to),
    limit: firstSearchValue(rawSearchParams.limit) ?? "50"
  });
  let page: Awaited<ReturnType<typeof listAuditRecords>>;

  try {
    page = await listAuditRecords(ctx, filters);
  } catch (error) {
    if (error instanceof AuditAuthorizationError) {
      return (
        <section className="resource-page" data-testid="audit-denied">
          <header className="resource-header">
            <div>
              <p className="eyebrow">{t("eyebrow")}</p>
              <h1>{t("deniedTitle")}</h1>
              <p>{t("deniedSubtitle")}</p>
            </div>
            <Link className="secondary-button" href={`/${appLocale}/app`}>
              {t("backToWorkspace")}
            </Link>
          </header>
        </section>
      );
    }

    throw error;
  }

  return (
    <section className="resource-page" data-testid="audit-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <div className="app-actions">
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
          <Link className="secondary-button" data-testid="audit-export-link" href={exportHref(rawSearchParams)}>
            {t("export")}
          </Link>
        </div>
      </header>

      <section className="detail-panel">
        <form className="resource-form audit-filter-form" data-testid="audit-filter-form">
          <div className="form-grid five">
            <label className="field">
              <span>{t("filters.action")}</span>
              <input
                data-testid="audit-action-filter"
                defaultValue={searchValueOrEmpty(rawSearchParams.action)}
                name="action"
              />
            </label>
            <label className="field">
              <span>{t("filters.resourceType")}</span>
              <input
                data-testid="audit-resource-filter"
                defaultValue={searchValueOrEmpty(rawSearchParams.resourceType)}
                name="resourceType"
              />
            </label>
            <label className="field">
              <span>{t("filters.actorId")}</span>
              <input defaultValue={searchValueOrEmpty(rawSearchParams.actorId)} name="actorId" />
            </label>
            <label className="field">
              <span>{t("filters.from")}</span>
              <input defaultValue={searchValueOrEmpty(rawSearchParams.from)} name="from" type="date" />
            </label>
            <label className="field">
              <span>{t("filters.to")}</span>
              <input defaultValue={searchValueOrEmpty(rawSearchParams.to)} name="to" type="date" />
            </label>
          </div>
          <label className="field">
            <span>{t("filters.requestId")}</span>
            <input
              data-testid="audit-request-filter"
              defaultValue={searchValueOrEmpty(rawSearchParams.requestId)}
              name="requestId"
            />
          </label>
          <button className="primary-button" data-testid="audit-filter-submit" type="submit">
            {t("filters.apply")}
          </button>
        </form>
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{t("records")}</h2>
          <span>{t("count", { count: page.total })}</span>
        </div>
        {page.records.length === 0 ? (
          <p className="empty-state" data-testid="audit-empty">
            {t("empty")}
          </p>
        ) : (
          <div className="audit-table" role="table" aria-label={t("records")}>
            <div className="audit-table-head" role="row">
              <span role="columnheader">{t("columns.when")}</span>
              <span role="columnheader">{t("columns.actor")}</span>
              <span role="columnheader">{t("columns.action")}</span>
              <span role="columnheader">{t("columns.resource")}</span>
              <span role="columnheader">{t("columns.reason")}</span>
              <span role="columnheader">{t("columns.change")}</span>
            </div>
            {page.records.map((record) => (
              <article className="audit-table-row" data-testid="audit-row" key={record.id} role="row">
                <span role="cell">
                  <strong>{formatDateTime(appLocale, record.occurredAt)}</strong>
                  <small>{record.requestId}</small>
                </span>
                <span role="cell">{record.actorId ?? t("systemActor")}</span>
                <span role="cell">
                  <strong>{record.action}</strong>
                  <small>{record.ipAddress ?? "-"}</small>
                </span>
                <span role="cell">
                  <strong>{record.resourceType}</strong>
                  <small>{record.resourceId ?? "-"}</small>
                </span>
                <span role="cell">{record.reason ?? "-"}</span>
                <span role="cell">
                  <code>{jsonPreview(record.before)}</code>
                  <code>{jsonPreview(record.after)}</code>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

