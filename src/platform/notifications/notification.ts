import { z } from "zod";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";

export const notificationEventType = "notification.requested";
export const notificationInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staff_document_expiring"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("approval_requested"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("approval_decided"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("language_updated"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("task_assigned"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("reservation_created"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("task_completed"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("security_session_revoked"), recipientId: z.string().uuid(), targetId: z.string().uuid() }).strict()
]);
export type NotificationInput = z.infer<typeof notificationInputSchema>;
export const notificationPageSchema = z.object({
  cursor: z.object({ createdAt: z.iso.datetime(), id: z.string().uuid() }).strict().nullable().optional()
}).strict();
export type NotificationCursor = NonNullable<z.infer<typeof notificationPageSchema>["cursor"]>;
export type NotificationItem = {
  id: string;
  kind: NotificationInput["kind"];
  createdAt: string;
  readAt: string | null;
  available: boolean;
  resolution?: string | null;
};
export type NotificationPage = { items: NotificationItem[]; unreadCount: number; nextCursor: NotificationCursor | null };

// Like own-factor configuration, an inbox is a capability over this account only.
// Business permissions are still checked independently before returning a destination.
export function ownNotificationContext(ctx: AuthContext, accountId: string): AuthContext {
  const scope = { organizationId: ctx.organizationId, resourceType: "notification", resourceId: accountId };
  const permissions = new Set(["notification:view", "notification:edit"]);
  return { ...ctx, userAccountId: accountId,
    permissions: new Set([...ctx.permissions, ...permissions]),
    scopes: [...ctx.scopes, scope],
    assignments: [...(ctx.assignments ?? ctx.scopes.map((scope) => ({ scope, permissions: ctx.permissions }))), { scope, permissions }]
  };
}

export function notificationDestination(
  ctx: AuthContext, input: NotificationInput, target: Resource | null, locale: "en" | "fr" | "ar"
): string | null {
  const referenceId = input.kind === "staff_document_expiring" ? target?.documentId : target?.id;
  if (input.recipientId !== ctx.userAccountId || !target || referenceId !== input.targetId) return null;
  if (input.kind === "language_updated" || input.kind === "security_session_revoked") {
    if (target.type !== "identity" || target.id !== ctx.userAccountId || target.organizationId !== ctx.organizationId) return null;
    const self = { organizationId: ctx.organizationId, resourceType: "identity", resourceId: ctx.userAccountId };
    const permissions = new Set(["identity:configure"]);
    const selfContext = { ...ctx, permissions: new Set([...ctx.permissions, ...permissions]),
      assignments: [{ scope: self, permissions }] };
    return authorize(selfContext, "configure", target) ? `/${locale}/app${input.kind === "security_session_revoked" ? "/security" : ""}` : null;
  }
  if (!authorize(ctx, "view", target)) return null;
  if (input.kind === "staff_document_expiring") return target.type === "staff_document" && target.assignedPersonId && target.id === target.assignedPersonId ? `/${locale}/app/team/${target.assignedPersonId}` : null;
  if (input.kind === "approval_requested" || input.kind === "approval_decided") return target.type === "property" ? `/${locale}/app/approvals/${target.id}` : null;
  if (input.kind === "reservation_created") return target.type === "reservation" ? `/${locale}/app/reservations` : null;
  if (target.type !== "task") return null;
  return target.assignedUserAccountId === ctx.userAccountId ? `/${locale}/app/field/${target.id}` : `/${locale}/app/operations`;
}
