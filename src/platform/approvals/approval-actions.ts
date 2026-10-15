"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { captureException } from "@/platform/observability/sentry";
import { ApprovalAccessError, ApprovalConflictError } from "./approval";
import { requestApproval, decideApproval } from "./approval-service";

async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof notificationActorFromSession>>>) => Promise<T>) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) throw new ApprovalAccessError();
    return { ok: true as const, data: await work(actor) };
  } catch (error) {
    if (!(error instanceof z.ZodError || error instanceof ApprovalAccessError || error instanceof ApprovalConflictError)) await captureException(error, { source: "api", requestId, tags: { feature: "approval-notifications" } });
    return { ok: false as const };
  }
}
export async function approvalRequestAction(input: unknown) { return run((actor) => requestApproval(actor, input)); }
export async function approvalDecisionAction(input: unknown) {
  return run(async (actor) => { await decideApproval(actor, input); revalidatePath("/[locale]/app/approvals/[id]", "page"); return null; });
}
