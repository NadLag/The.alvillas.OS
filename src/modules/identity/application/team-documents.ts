import { randomUUID } from "node:crypto";
import { z } from "zod";
import { documentSchema, teamPolicyKey, teamPolicySchema } from "../domain/team";
import { TeamRepository } from "../infrastructure/team-repository";
import type { IdentityActorContext } from "./identity-access";
import { IdentityAuthorizationError } from "./identity-access";
import { TeamNotFoundError, TeamConflictError, teamAudit } from "./team-service";
import { authorize } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { R2StorageProvider } from "@/platform/providers/real";
import type { StorageProvider } from "@/platform/providers";
import { publishNotification } from "@/platform/notifications/notification-service";
import { decryptBytes, encryptBytes } from "@/platform/auth/secret-encryption";

export type PrivateDocumentStorage = StorageProvider & {
  createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
};
type Deps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  storage?: PrivateDocumentStorage;
  transport?: typeof fetch;
};
function encryptionContext(document: {
  organizationId: string;
  personId: string;
  storageKey: string;
  contentType: string;
  size: number;
}) {
  return JSON.stringify([
    "staff-document-v1",
    document.organizationId,
    document.personId,
    document.storageKey,
    document.contentType,
    document.size
  ]);
}
async function boundedDocumentBody(response: Response, limit: number) {
  if (!response.ok || !response.body)
    throw new TeamConflictError("Private document storage is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new TeamConflictError("Private document content is invalid");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function validDocumentBytes(type: string, bytes: Uint8Array) {
  const start = Buffer.from(bytes.subarray(0, 8));
  return type === "application/pdf"
    ? start.subarray(0, 5).toString() === "%PDF-"
    : type === "image/png"
      ? start.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
}
async function policy(repository: TeamRepository) {
  const rule = await new ConfigRuleRepository(repository.tx, repository.organizationId).resolve({
    key: teamPolicyKey,
    scopes: [{ scopeType: "organization", scopeId: null }]
  });
  if (!rule) throw new TeamConflictError("Staff document policy must be configured");
  return teamPolicySchema.parse(rule.parsedValue);
}
export async function uploadTeamDocument(
  ctx: IdentityActorContext,
  input: unknown,
  bytes: Uint8Array,
  deps: Deps = {}
) {
  const value = documentSchema.parse(input);
  if (bytes.length !== value.size || !validDocumentBytes(value.contentType, bytes))
    throw new TeamConflictError("Document content does not match its declared file type");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    if (
      !authorize(
        ctx.authContext,
        "create",
        repository.resource({ id: value.personId }, "staff_document")
      )
    )
      throw new IdentityAuthorizationError();
    await repository.lock(value.personId);
    const person = await repository.person(value.personId);
    if (!person || person.archivedAt) throw new TeamNotFoundError();
    const settings = await policy(repository);
    if (value.size > settings.document_max_bytes)
      throw new TeamConflictError("Document exceeds configured upload limit");
    const storageKey = `${ctx.organizationId}/staff/${person.id}/${randomUUID()}`;
    const encrypted = encryptBytes(
      bytes,
      encryptionContext({
        organizationId: ctx.organizationId,
        personId: person.id,
        storageKey,
        contentType: value.contentType,
        size: value.size
      })
    );
    const storage = deps.storage ?? new R2StorageProvider();
    const { url } = await storage.createSignedUploadUrl({
      key: storageKey,
      contentType: "application/octet-stream"
    });
    const response = await (deps.transport ?? fetch)(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(encrypted),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new TeamConflictError("Private document storage is unavailable");
    const row = await repository.createDocument({
      personId: person.id,
      title: value.title,
      kind: value.kind,
      storageKey,
      contentType: value.contentType,
      size: value.size,
      expiresOn: value.expiresOn ? new Date(value.expiresOn) : null,
      confirmedAt: new Date(),
      createdBy: ctx.actorId
    });
    await teamAudit(
      repository,
      ctx,
      "document.upload",
      row.id,
      { personId: person.id, kind: row.kind, expiresOn: row.expiresOn },
      value.reason,
      deps
    );
    return { id: row.id };
  });
}
export async function downloadTeamDocument(ctx: IdentityActorContext, id: string, deps: Deps = {}) {
  z.string().uuid().parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const row = await repository.document(id);
    if (!row) throw new TeamNotFoundError();
    if (!authorize(ctx.authContext, "view", repository.resource({ id: row.personId }, "staff_document")))
      throw new IdentityAuthorizationError();
    const settings = await policy(repository);
    const { url } = await (deps.storage ?? new R2StorageProvider()).createSignedDownloadUrl({
      key: row.storageKey,
      expiresInSeconds: settings.document_link_seconds
    });
    const response = await (deps.transport ?? fetch)(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    const encrypted = await boundedDocumentBody(response, row.size + 256);
    const bytes = decryptBytes(encrypted, encryptionContext(row));
    if (bytes.length !== row.size || !validDocumentBytes(row.contentType, bytes))
      throw new TeamConflictError("Private document content is invalid");
    await teamAudit(
      repository,
      ctx,
      "document.download",
      row.id,
      { personId: row.personId },
      "Authorized private document access",
      deps
    );
    return { bytes, contentType: row.contentType, title: row.title };
  });
}
export async function archiveTeamDocument(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = z
    .object({ id: z.string().uuid(), reason: z.string().trim().min(6).max(500) })
    .strict()
    .parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const row = await repository.document(value.id);
    if (!row) throw new TeamNotFoundError();
    if (!authorize(ctx.authContext, "edit", repository.resource({ id: row.personId }, "staff_document")))
      throw new IdentityAuthorizationError();
    await repository.archiveDocument(row.id);
    await teamAudit(repository, ctx, "document.archive", row.id, { archived: true }, value.reason, deps);
  });
}

export async function scheduleTeamDocumentReminders(
  organizationId: string,
  deps: Deps & { now?: Date } = {}
) {
  const now = deps.now ?? new Date();
  let cursor: string | undefined;
  let count = 0;
  do {
    const batch = await withTenant(deps.db ?? prisma, organizationId, async (tx) => {
      const repository = new TeamRepository(tx, organizationId);
      const rule = await new ConfigRuleRepository(tx, organizationId).resolve({
        key: teamPolicyKey,
        scopes: [{ scopeType: "organization", scopeId: null }],
        asOf: now
      });
      if (!rule) return [];
      const settings = teamPolicySchema.parse(rule.parsedValue);
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Casablanca",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(now);
      const day = new Date(today).getTime();
      const documents = await repository.dueDocuments(
        new Date(day + Math.max(...settings.document_reminder_days) * 86400000),
        cursor
      );
      for (const document of documents) {
        const days = (document.expiresOn!.getTime() - day) / 86400000;
        const threshold = [...settings.document_reminder_days]
          .sort((a, b) => a - b)
          .find((n) => days <= n);
        if (threshold === undefined) continue;
        await publishNotification(
          tx,
          organizationId,
          { kind: "staff_document_expiring", targetId: document.id, recipientId: document.createdBy },
          `staff-document:${document.id}:${document.expiresOn!.toISOString()}:${threshold}`
        );
      }
      return documents;
    });
    count += batch.length;
    cursor = batch.length === 100 ? batch.at(-1)!.id : undefined;
  } while (cursor);
  return count;
}
