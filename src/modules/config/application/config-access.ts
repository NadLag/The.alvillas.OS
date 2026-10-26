import type { Session } from "next-auth";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import type { AuthContext } from "@/platform/authz/authorize";

export type ConfigActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

export async function configActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof identityActorContextFromSession>[1] = {}
): Promise<ConfigActorContext | null> {
  if (session?.user?.securitySetupRequired || session?.user?.sessionRevoked) return null;
  return identityActorContextFromSession(session, deps);
}
