import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import type { AuthContext } from "@/platform/authz/authorize";

export type CoreActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

export async function coreActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<CoreActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}

export async function agreementActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<CoreActorContext | null> {
  return coreActorContextFromSession(session, deps);
}
