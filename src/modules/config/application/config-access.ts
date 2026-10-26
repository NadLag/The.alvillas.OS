import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import type { AuthContext } from "@/platform/authz/authorize";

export type ConfigActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

export async function configActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<ConfigActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id, personId: user.personId,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}
