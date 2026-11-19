import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/design-system/shells";
import { formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { personalDocumentTypes } from "../domain/personal-document";
import { canUseHousehold } from "../domain/household-access";
import { personalWorkspace } from "../application/personal-session";
import { PersonalDocumentRepository } from "../application/personal-documents";
import { PersonalForm } from "./personal-form";

export async function DocumentsPanel({ locale, householdId, archived, after }: {
  locale: AppLocale; householdId: string; archived: boolean; after?: string;
}) {
  const [t, page] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }),
    personalWorkspace(locale, householdId, async (scope) => ({
      ...(await new PersonalDocumentRepository(scope).list(archived, after)),
      canEdit: canUseHousehold(scope.authority, scope.id, "documents", "edit")
    }))
  ]);
  return <section className="detail-panel">
    <h2>{t(archived ? "archivedDocuments" : "sections.documents")}</h2>
    {page.canEdit ? <Link className="secondary-button" prefetch={false} href={archived ? "?" : "?archived=1"}>
      {t(archived ? "activeDocuments" : "archivedDocuments")}
    </Link> : null}
    {page.canEdit && !archived ? <details>
      <summary>{t("upload")}</summary>
      <PersonalForm target={{ locale, householdId, command: "upload" }} submitLabel={t("upload")}>
        <input name="id" type="hidden" value={randomUUID()} />
        <label>{t("name")}<input name="displayName" maxLength={120} required /></label>
        <label>{t("file")}<input name="file" type="file" accept={personalDocumentTypes.join(",")} required /></label>
        <p>{t("fileLimit")}</p>
      </PersonalForm>
    </details> : null}
    {page.items.length ? <ul className="form-grid">
      {page.items.map((doc) => <li className="form-actions" key={doc.id}>
        <strong dir="auto">{doc.displayName}</strong>
        <time dateTime={doc.createdAt.toISOString()}>{formatDate(locale, doc.createdAt)}</time>
        {!archived ? <a className="secondary-button" href={`/api/personal/${householdId}/documents/${doc.id}`}>{t("download")}</a> : null}
        {page.canEdit ? <PersonalForm target={{ locale, householdId, command: archived ? "restore" : "archive" }}
          submitLabel={t(archived ? "restore" : "archive")}>
          <input name="id" type="hidden" value={doc.id} />
        </PersonalForm> : null}
      </li>)}
    </ul> : <EmptyState>{t("empty")}</EmptyState>}
    {page.next ? <Link className="secondary-button" prefetch={false} href={`?after=${page.next}${archived ? "&archived=1" : ""}`}>{t("next")}</Link> : null}
  </section>;
}
