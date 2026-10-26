import type { Session } from "next-auth";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import type { AuthContext } from "@/platform/authz/authorize";

export type CoreActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

export async function coreActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof identityActorContextFromSession>[1] = {}
): Promise<CoreActorContext | null> {
  if (session?.user?.securitySetupRequired || session?.user?.sessionRevoked) return null;
  return identityActorContextFromSession(session, deps);
}

export async function agreementActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof identityActorContextFromSession>[1] = {}
): Promise<CoreActorContext | null> {
  return coreActorContextFromSession(session, deps);
}
