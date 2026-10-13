import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { auditActorContextFromSession } from "@/modules/audit/application/audit-access";
import {
  AuditAuthorizationError,
  auditFilterSchema,
  listAuditHistory,
  type AuditHistoryResult
} from "@/modules/audit/application/audit-service";
import { auth } from "@/platform/auth/session";
import { formatDateTime } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

type AuditPageSearchParams = {
  action?: string | string[];
  resourceType?: string | string[];
  actorId?: string | string[];
  resourceId?: string | string[];
  propertyScopeId?: string | string[];
  from?: string | string[];
  to?: string | string[];
};

const filterKeys = [
  "action",
  "resourceType",
  "actorId",
  "resourceId",
  "propertyScopeId",
  "from",
  "to"
] as const;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function auditFilterInput(searchParams: AuditPageSearchParams) {
  return Object.fromEntries(
    filterKeys.map((key) => [key, firstParam(searchParams[key]) ?? ""])
  );
}

function exportHref(input: Record<string, string | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(input)) {
    const trimmed = value?.trim();
    if (trimmed) {
      params.set(key, trimmed);
    }
  }

  const query = params.toString();
  return query ? `/api/audit/export?${query}` : "/api/audit/export";
}

function jsonPreview(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

export default async function AuditPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<AuditPageSearchParams>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = await auditActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, rawSearchParams] = await Promise.all([getTranslations("Audit"), searchParams]);
  const filterInput = auditFilterInput(rawSearchParams);
  const parsedFilters = auditFilterSchema.safeParse(filterInput);
  const filters = parsedFilters.success ? parsedFilters.data : {};

  let history: AuditHistoryResult;

  try {
    history = await listAuditHistory(ctx, filters);
  } catch (error) {
    if (error instanceof AuditAuthorizationError) {
      return (
        <AdminShell className="resource-page" testId="audit-denied">
          <ShellHeader
            actions={
            <Link className="secondary-button" href={`/${appLocale}/app`}>
              {t("backToWorkspace")}
            </Link>
            }
            eyebrow={t("eyebrow")}
            subtitle={t("denied.subtitle")}
            title={t("denied.title")}
          />
        </AdminShell>
      );
    }

    throw error;
  }

  return (
    <AdminShell className="resource-page" testId="audit-page">
      <ShellHeader
        actions={
          <>
          <a className="secondary-button" data-testid="audit-export-link" href={exportHref(filterInput)}>
            {t("export")}
          </a>
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
          </>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      <form action={`/${appLocale}/app/audit`} className="audit-filter-form" method="get">
        <label className="field">
          {t("filters.action")}
          <input
            data-testid="audit-filter-action"
            defaultValue={filterInput.action}
            name="action"
            placeholder={t("filters.actionPlaceholder")}
          />
        </label>
        <label className="field">
          {t("filters.resourceType")}
          <input
            data-testid="audit-filter-resource-type"
            defaultValue={filterInput.resourceType}
            name="resourceType"
            placeholder={t("filters.resourceTypePlaceholder")}
          />
        </label>
        <label className="field">
          {t("filters.actor")}
          <input data-testid="audit-filter-actor" defaultValue={filterInput.actorId} name="actorId" />
        </label>
        <label className="field">
          {t("filters.resourceId")}
          <input data-testid="audit-filter-resource-id" defaultValue={filterInput.resourceId} name="resourceId" />
        </label>
        <label className="field">
          {t("filters.from")}
          <input data-testid="audit-filter-from" defaultValue={filterInput.from} name="from" type="date" />
        </label>
        <label className="field">
          {t("filters.to")}
          <input data-testid="audit-filter-to" defaultValue={filterInput.to} name="to" type="date" />
        </label>
        <button className="primary-button" data-testid="audit-filter-submit" type="submit">
          {t("filters.apply")}
        </button>
      </form>

      <section className="workspace-main audit-history-panel">
        <div className="section-heading">
          <p className="panel-label">{t("listLabel")}</p>
          <span data-testid="audit-count">
            {t("count", {
              count: history.rows.length,
              total: history.total
            })}
          </span>
        </div>
        {history.rows.length === 0 ? (
          <EmptyState testId="audit-empty" tone="motif">{t("empty")}</EmptyState>
        ) : (
          <div className="audit-table" data-testid="audit-table">
            <div className="audit-table-head" role="row">
              <span>{t("columns.when")}</span>
              <span>{t("columns.actor")}</span>
              <span>{t("columns.action")}</span>
              <span>{t("columns.resource")}</span>
              <span>{t("columns.reason")}</span>
            </div>
            {history.rows.map((row) => (
              <details className="audit-row" data-testid="audit-row" key={row.id}>
                <summary>
                  <span>{formatDateTime(appLocale, row.occurredAt)}</span>
                  <span>{row.actorId ?? t("systemActor")}</span>
                  <strong>{row.action}</strong>
                  <span>
                    {row.resourceType}
                    {row.resourceId ? ` ${row.resourceId}` : ""}
                  </span>
                  <span>{row.reason ?? t("noReason")}</span>
                </summary>
                <dl className="audit-row-details">
                  <div>
                    <dt>{t("details.request")}</dt>
                    <dd>{row.requestId}</dd>
                  </div>
                  <div>
                    <dt>{t("details.where")}</dt>
                    <dd>{row.ipAddress ?? t("notRecorded")}</dd>
                  </div>
                  <div>
                    <dt>{t("details.device")}</dt>
                    <dd>{row.deviceId ?? t("notRecorded")}</dd>
                  </div>
                  <div>
                    <dt>{t("details.scope")}</dt>
                    <dd>{row.propertyScopeId ?? t("organizationScope")}</dd>
                  </div>
                  <div className="wide">
                    <dt>{t("details.before")}</dt>
                    <dd>
                      <pre>{jsonPreview(row.before) || t("notRecorded")}</pre>
                    </dd>
                  </div>
                  <div className="wide">
                    <dt>{t("details.after")}</dt>
                    <dd>
                      <pre>{jsonPreview(row.after) || t("notRecorded")}</pre>
                    </dd>
                  </div>
                </dl>
              </details>
            ))}
          </div>
        )}
      </section>
    </AdminShell>
  );
}
