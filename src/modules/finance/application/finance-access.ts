import type { Session } from "next-auth";
import { authorize, type Action, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authContextForAccount, authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { TenantTransaction } from "@/platform/db/tenant";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

/** Called after the period lock: retain caller restrictions and re-read stored grants. */
export async function recheckFinanceAuthorization(ctx: FinanceActorContext, tx: TenantTransaction, now: Date,
  checks: ReadonlyArray<{ action: Action; resource: Resource }>, denied: Error) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw denied;
  const current = { ...(await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId)), personId: ctx.authContext.personId };
  if (checks.some(({ action, resource }) => resource.organizationId !== ctx.organizationId ||
    [ctx.authContext, current].some(authority => !authorize(authority, action, resource, now)))) throw denied;
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
