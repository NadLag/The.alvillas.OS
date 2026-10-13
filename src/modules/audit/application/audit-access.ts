import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import type { AuthContext } from "@/platform/authz/authorize";

export type AuditActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

type AuditAccessDeps = {
  db?: NonNullable<Parameters<typeof authContextForAccount>[2]>["db"];
};

export async function auditActorContextFromSession(
  session: Session | null,
  deps: AuditAccessDeps = {}
): Promise<AuditActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      ...(await authContextForAccount(user.organizationId, user.id, deps)),
      personId: user.personId
    }
  };
}

