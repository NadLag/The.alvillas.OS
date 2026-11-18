import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatDate } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { prisma } from "@/platform/db/client";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { listOwnerPortalProperties } from "@/modules/owner-portal/application/owner-portal-service";
import { readDocumentSourceWorkspace } from "@/modules/documents/application/document-workspace";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "@/modules/documents/domain/document-command";

export default async function OwnerDocumentsPage({ params }: { params: Promise<{ locale: string; propertyId: string }> }) {
  const [{ locale: requested, propertyId }, session] = await Promise.all([params, auth()]);
  const locale = safeLocale(requested);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [owner, actor, t] = await Promise.all([ownerPortalActorContextFromSession(session),
    accountActorContextFromSession(session), getTranslations("OwnerPortal.documents")]);
  if (!owner || !owner.propertyIds.includes(propertyId)) notFound();
  const properties = (await listOwnerPortalProperties(owner)).filter(row => row.propertyId === propertyId);
  if (!properties.length) notFound();

  const sources = [{ kind: "PROPERTY" as const, id: propertyId },
    ...properties.map(row => ({ kind: "OWNER" as const, id: row.ownerId }))];
  const archives = actor?.authContext.permissions.has("document:view") ? await Promise.all(sources.map(async source => {
    try { return await readDocumentSourceWorkspace(actor, { source, kind: "FILE" }, { db: prisma }); }
    catch (error) {
      if (error instanceof DocumentAccessError || error instanceof DocumentConfigurationError || error instanceof DocumentConflictError) return null;
      throw error;
    }
  })) : [];
  const current = (await listOwnerPortalProperties(owner)).filter(row => row.propertyId === propertyId);
  if (!current.length) notFound();
  const currentOwners = new Set(current.map(row => row.ownerId));
  const visible = archives.filter(archive => archive && (archive.source.kind === "PROPERTY" || currentOwners.has(archive.source.id)));
  const propertyPath = `/${locale}/app/owner-portal/properties/${propertyId}`;
  const archivePath = `/${locale}/app/documents`;
  return <OwnerShell className="resource-page" testId="owner-documents">
    <ShellHeader title={t("title")} eyebrow={current[0].propertyName} actions={<Link className="secondary-button" href={propertyPath}>{t("back")}</Link>} />
    {visible.length ? visible.map(archive => archive ? <section className="panel resource-form" key={archive.source.kind + ":" + archive.source.id}>
      <h2 dir="auto">{archive.sourceLabel}</h2>
      <Link className="secondary-button" href={archivePath + (archive.source.kind === "OWNER" ? "?owner=" : "?property=") + archive.source.id}>
        {t("open")}
      </Link>
      {archive.items.length ? <ul className="resource-list">{archive.items.slice(0, 20).map(item => <li className="resource-row" key={item.id}>
        <strong dir="auto">{item.title}</strong><span>{formatDate(locale, new Date(item.createdAt), { timeZone: "UTC" })}</span>
      </li>)}</ul> : <p>{t("empty")}</p>}
    </section> : null) : <EmptyState tone="motif">{t("empty")}</EmptyState>}
  </OwnerShell>;
}
