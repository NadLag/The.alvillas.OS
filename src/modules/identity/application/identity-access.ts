import type { Session } from "next-auth";
import { identityResource } from "@/modules/identity/domain/identity";
import {
  authorize,
  type AuthContext
} from "@/platform/authz/authorize";
import {
  authContextForAccount as buildAuthContextForAccount
} from "@/platform/authz/account-context";

export type IdentityActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

type IdentityAccessDeps = {
  db?: NonNullable<Parameters<typeof buildAuthContextForAccount>[2]>["db"];
};

export async function authContextForAccount(
  organizationId: string,
  userAccountId: string,
  deps: IdentityAccessDeps = {}
): Promise<AuthContext> {
  return buildAuthContextForAccount(organizationId, userAccountId, deps);
}

export async function identityActorContextFromSession(
  session: Session | null,
  deps: IdentityAccessDeps = {}
): Promise<IdentityActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  const accountContext = await authContextForAccount(user.organizationId, user.id, deps);
  // An authenticated person may configure their own factors. This grant cannot reach
  // the identity collection, another person, roles, or business records.
  const ownSecurityScope = { organizationId: user.organizationId, resourceType: identityResource, resourceId: user.id };
  const ownSecurityPermissions = new Set(["identity:configure"]);
  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      ...accountContext,
      personId: user.personId,
      permissions: new Set([...accountContext.permissions, ...ownSecurityPermissions]),
      scopes: [...accountContext.scopes, ownSecurityScope],
      assignments: [...(accountContext.assignments ?? []), { scope: ownSecurityScope, permissions: ownSecurityPermissions }]
    }
  };
}

export function assertIdentityAllowed(
  ctx: IdentityActorContext,
  action: Parameters<typeof authorize>[1],
  id?: string
): void {
  if (
    !authorize(ctx.authContext, action, {
      type: identityResource,
      organizationId: ctx.organizationId,
      id
    })
  ) {
    throw new IdentityAuthorizationError();
  }
}

export class IdentityAuthorizationError extends Error {
  constructor(message = "Identity action is not authorized") {
    super(message);
    this.name = "IdentityAuthorizationError";
  }
}
