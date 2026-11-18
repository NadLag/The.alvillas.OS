"use server";

import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { ownerPortalActorContextFromSession } from "./owner-portal-access";
import { decideOwnerApproval } from "./owner-approvals";

export async function ownerApprovalDecisionAction(propertyId: string, input: unknown) {
  const session = await auth();
  const [owner, actor] = await Promise.all([ownerPortalActorContextFromSession(session), notificationActorFromSession(session)]);
  if (!owner || !actor) return { ok: false as const };
  try { await decideOwnerApproval(owner, actor, propertyId, input); return { ok: true as const, data: null }; }
  catch { return { ok: false as const }; }
}
