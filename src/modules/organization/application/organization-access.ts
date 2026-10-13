import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import { authorize, type Action, type AuthContext } from "@/platform/authz/authorize";

export type OrganizationActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

export async function organizationActorContextFromSession(
  session: Session | null
): Promise<OrganizationActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  const accountContext = await authContextForAccount(user.organizationId, user.id);

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      ...accountContext,
      personId: user.personId,
      scopes: accountContext.scopes.length > 0 ? accountContext.scopes : [{ organizationId: user.organizationId }]
    }
  };
}

export function assertOrganizationAllowed(ctx: OrganizationActorContext, action: Action): void {
  if (
    !authorize(ctx.authContext, action, {
      type: "organization",
      organizationId: ctx.organizationId,
      id: ctx.organizationId
    })
  ) {
    throw new OrganizationAuthorizationError();
  }
}

export class OrganizationAuthorizationError extends Error {
  constructor(message = "Organization action is not authorized") {
    super(message);
    this.name = "OrganizationAuthorizationError";
  }
}
