import type { Session } from "next-auth";
import type { AuthContext } from "@/platform/authz/authorize";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

export async function financeActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof identityActorContextFromSession>[1] = {}
): Promise<FinanceActorContext | null> {
  if (session?.user?.securitySetupRequired || session?.user?.sessionRevoked) return null;
  return identityActorContextFromSession(session, deps);
}
