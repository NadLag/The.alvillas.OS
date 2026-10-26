import type { Session } from "next-auth";
import type { AuthContext } from "@/platform/authz/authorize";
import { authContextForAccount } from "@/platform/authz/account-context";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

export async function financeActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<FinanceActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}
