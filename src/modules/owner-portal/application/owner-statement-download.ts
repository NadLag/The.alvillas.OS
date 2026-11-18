import { createHash, randomUUID } from "node:crypto";
import { formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { spreadsheetCsvCell } from "@/platform/exports/spreadsheet-cell";
import { OwnerPortalRepository } from "../infrastructure/owner-portal-repository";
import { renderOwnerStatementDownloadPdf } from "../infrastructure/owner-statement-download-renderer";
import type { OwnerStatementBucket } from "../domain/owner-statement";
import { renderOwnerStatementDocument } from "./owner-statement-documents";
import { getOwnerStatement, OwnerPortalNotFoundError } from "./owner-portal-service";

export async function downloadOwnerStatement(
  actor: Parameters<typeof getOwnerStatement>[0], propertyId: string, period: Parameters<typeof getOwnerStatement>[2],
  locale: AppLocale, format: "csv" | "pdf", labels: {
    date: string; bucket: string; reference: string; amount: string; currency: string;
    opening: string; credits: string; debits: string; closing: string;
    bucketName: (bucket: OwnerStatementBucket) => string;
  }, deps: Parameters<typeof getOwnerStatement>[3] = {}
) {
  const statement = await getOwnerStatement(actor, propertyId, period, deps);
  let bytes: Uint8Array;
  if (format === "pdf") {
    bytes = await renderOwnerStatementDownloadPdf(renderOwnerStatementDocument(statement, locale));
  } else {
    const record = (label: string, amount: string) => ["", label, "", amount, statement.currency];
    const lines = [
      [labels.date, labels.bucket, labels.reference, labels.amount, labels.currency],
      record(labels.opening, statement.openingBalance.toJSON().amount),
      record(labels.credits, statement.periodCreditTotal.toJSON().amount),
      record(labels.debits, statement.periodDebitTotal.toJSON().amount),
      record(labels.closing, statement.closingBalance.toJSON().amount),
      ...statement.lines.map(line => [formatDate(locale, line.occurredAt, { timeZone: statement.timezone }),
        labels.bucketName(line.bucket), line.reference, line.signedAmount.toJSON().amount, statement.currency])
    ];
    const csv = lines.map((row, index) => row.map((cell, column) => spreadsheetCsvCell(cell, index > 0 && column === 3)).join(",")).join("\r\n");
    bytes = new TextEncoder().encode("\uFEFF" + csv + "\r\n");
  }
  const filename = `statement-${statement.fromOn}-${statement.toOn}-${statement.currency}.${format}`;
  await withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new OwnerPortalRepository(tx, actor.organizationId);
    const access = await repository.findOwnerPropertyAccess(actor.actorId, propertyId);
    if (access?.ownerId !== statement.ownerId) throw new OwnerPortalNotFoundError();
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId,
      action: "owner_statement.downloaded", resourceType: "owner_statement", resourceId: propertyId, propertyScopeId: propertyId,
      after: { ownerId: statement.ownerId, filename, locale, format, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
      requestId: deps.requestId ?? randomUUID(), occurredAt: new Date() });
    if ((await repository.findOwnerPropertyAccess(actor.actorId, propertyId))?.ownerId !== statement.ownerId) throw new OwnerPortalNotFoundError();
  });
  return { bytes, filename };
}
