import type { Session } from "next-auth";
import { type Action, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authContextForAccount } from "@/platform/authz/account-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import type { TenantTransaction } from "@/platform/db/tenant";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

/** Called after the period lock: retain caller restrictions and re-read stored grants. */
export async function recheckFinanceAuthorization(ctx: FinanceActorContext, tx: TenantTransaction, now: Date,
  checks: ReadonlyArray<{ action: Action; resource: Resource; organizationOnly?: boolean }>, denied: Error) {
  await recheckAccountAuthorization(ctx, tx, now, checks, denied);
}

export async function financeActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<FinanceActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}
