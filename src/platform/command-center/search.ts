import { z } from "zod";
import { authorize, authorizeCollection, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorizationScopeStamp } from "@/platform/authz/authority-stamp";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { localizedText, localizedTextSchema } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { readAssetSource } from "@/modules/assets/application/asset-service";
import { AssetAccessError } from "@/modules/assets/domain/asset";
import { nativeMaintenanceIssue } from "@/platform/maintenance/issue-sources";
import { MaintenanceIssueAccessError } from "@/modules/maintenance/domain/issue-context";
import { searchDocuments } from "@/modules/documents/application/document-search-service";
import { DocumentAccessError, DocumentConflictError } from "@/modules/documents/domain/document-command";
import { CommandSearchRepository, nativeSearchKinds, type NativeSearchKind } from "./search-repository";

const kinds = [...nativeSearchKinds, "document"] as const;
type SearchKind = typeof kinds[number];
const paths = { property: "/properties/", reservation: "/reservations/", task: "/operations/", issue: "/maintenance/issues/",
  asset: "/assets/", owner: "/owners/", supplier: "/finance/suppliers/" } satisfies Record<NativeSearchKind, string>;
export const searchFilters = z.object({ q: z.string().trim().min(2).max(120), kind: z.enum(kinds).optional(), after: z.string().max(6000).optional() });
type Filter = z.infer<typeof searchFilters>;
type Item = { id: string; title: string; href: string };
export type SearchGroup = { kind: SearchKind; items: Item[]; next: string | null };
export class CommandSearchChangedError extends Error {}

export function commandSearchKinds(ctx: AuthContext) {
  return kinds.filter(kind => authorizeCollection(ctx, "view", kind));
}

export async function searchCommandCenter(actor: AccountActorContext, input: Filter, locale: AppLocale,
  db: TenantTransactionRunner = prisma): Promise<SearchGroup[]> {
  if (actor.organizationId !== actor.authContext.organizationId || actor.actorId !== actor.authContext.userAccountId) return [];
  const allowed = commandSearchKinds(actor.authContext).filter(kind => !input.kind || kind === input.kind);
  const max = input.kind ? 20 : 5;
  const groups: SearchGroup[] = await withTenant(db, actor.organizationId, async tx => {
    const repository = new CommandSearchRepository(tx, actor.organizationId);
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    const now = new Date(), contexts = [actor.authContext, current];
    const matches = await Promise.all(allowed.filter(kind => kind !== "document" && authorizeCollection(current, "view", kind)).map(async kind => {
      if (kind === "document") return null;
      const items: Item[] = [];
      let cursor = z.uuid().safeParse(input.after).data;
      do {
        const rows = await repository.candidates(kind, input.q, cursor);
        for (const row of rows) {
          const resource: Resource = { type: kind, organizationId: actor.organizationId, id: row.id, propertyId: row.propertyId,
            city: row.city, region: row.region, status: row.status, assignedPersonId: row.assignedPersonId, assignedUserAccountId: row.assignedUserAccountId,
            ...(kind === "reservation" ? { reservationId: row.id } : kind === "task" ? { taskId: row.id, jobId: row.id } : kind === "owner" ? { ownerId: row.id } : {}) };
          let title = row.title;
          try {
            if (kind === "issue") title = (await nativeMaintenanceIssue(actor, tx, row.id)).row.title;
            else if (kind === "asset") title = (await readAssetSource(actor, tx, row.id)).label;
            else if (!contexts.every(ctx => authorize(ctx, "view", resource, now))) continue;
          } catch (error) {
            if (error instanceof MaintenanceIssueAccessError || error instanceof AssetAccessError) continue;
            throw error;
          }
          const labels = localizedTextSchema.safeParse(row.labels);
          if (labels.success) title = localizedText(labels.data, locale) || title;
          items.push({ id: row.id, title, href: paths[kind] + row.id });
          if (items.length > max) break;
        }
        cursor = rows.length === 50 ? rows[49].id : undefined;
      } while (cursor && items.length <= max);
      return { kind, items: items.slice(0, max), next: items.length > max ? items[max - 1].id : null };
    }));
    const rechecked = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    if (authorizationScopeStamp(current) !== authorizationScopeStamp(rechecked)) throw new CommandSearchChangedError();
    return matches.filter(group => group !== null);
  });
  if (!allowed.includes("document")) return groups;
  try {
    const { items, next } = await searchDocuments(actor, { query: input.q, kind: "ALL", includeArchived: false,
      versionSelection: "CURRENT_EFFECTIVE", cursor: input.after }, { db });
    groups.push({ kind: "document", items: items.slice(0, max).map(row => ({ id: row.version.id, title: row.version.title,
      href: "/documents?" + new URLSearchParams({ document: row.document.id, version: String(row.version.number) }).toString() })),
      next: input.kind ? next : items.length > max || next ? "more" : null });
  } catch (error) {
    if (error instanceof DocumentConflictError) throw new CommandSearchChangedError();
    if (!(error instanceof DocumentAccessError)) throw error;
  }
  return groups;
}
