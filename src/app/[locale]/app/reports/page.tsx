import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { AccountantExportWorkspace } from "@/modules/finance/ui/accountant-export-workspace";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { listOwnerPortalProperties } from "@/modules/owner-portal/application/owner-portal-service";
import { auth } from "@/platform/auth/session";
import { authorizeCollection } from "@/platform/authz/authorize";
import { canViewAccountantExport } from "@/platform/authz/accountant-export-resource";

export default async function ReportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const [finance, owner, t] = await Promise.all([
    financeActorContextFromSession(session), ownerPortalActorContextFromSession(session), getTranslations("ReportsWorkspace")
  ]);
  const hasReportAccess = finance && authorizeCollection(finance.authContext, "view", "report");
  const canGenerate = finance && hasReportAccess && canViewAccountantExport(finance.authContext, "export", new Date());
  const properties = owner ? (await listOwnerPortalProperties(owner)).filter(property => property.canViewFinances) : [];
  if (!hasReportAccess && !properties.length) notFound();

  return (
    <AdminShell className="resource-page" testId="reports-workspace">
      <ShellHeader eyebrow={t("eyebrow")} title={t("title")} actions={
        <Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>
      } />
      {canGenerate ? (
        <section className="detail-panel">
          <h2>{t("financialExports")}</h2>
          <AccountantExportWorkspace key={finance.organizationId + "." + finance.actorId} locale={locale} />
        </section>
      ) : null}
      {properties.length ? (
        <section className="detail-panel">
          <h2>{t("ownerReports")}</h2>
          <ul className="resource-list">{properties.map(property => (
            <li key={property.ownerId + "." + property.propertyId}>
              <Link className="resource-row" href={`/${locale}/app/owner-portal/properties/${property.propertyId}/reports`}>
                {property.propertyName}
              </Link>
            </li>
          ))}</ul>
        </section>
      ) : null}
      {!canGenerate && !properties.length ? <EmptyState tone="motif">{t("empty")}</EmptyState> : null}
    </AdminShell>
  );
}
