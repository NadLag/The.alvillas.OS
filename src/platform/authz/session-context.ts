import type { Session } from "next-auth";
import type { AuthContext } from "./authorize";
import { authContextForAccount } from "./account-context";

export type AccountActorContext = { organizationId: string; actorId: string; authContext: AuthContext };

/** Session identity selects the account; persisted grants supply its authority. */
export async function accountActorContextFromSession(session: Session | null, deps: Parameters<typeof authContextForAccount>[2] = {}): Promise<AccountActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}
