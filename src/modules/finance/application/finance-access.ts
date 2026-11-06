import type { Session } from "next-auth";
import { type AuthContext } from "@/platform/authz/authorize";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { recheckAccountAuthorization,type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { TenantTransaction } from "@/platform/db/tenant";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

/** Called after the period lock: retain caller restrictions and re-read stored grants. */
export async function recheckFinanceAuthorization(ctx: FinanceActorContext, tx: TenantTransaction, now: Date,
  checks: readonly CurrentAuthorityCheck[], denied: Error) {
  await recheckAccountAuthorization(ctx, tx, now, checks, denied);
}

export async function financeActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof accountActorContextFromSession>[1] = {}
): Promise<FinanceActorContext | null> {
  return accountActorContextFromSession(session, deps);
}
