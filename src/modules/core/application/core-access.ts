import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import {
  permissionKey,
  type AuthContext
} from "@/platform/authz/authorize";

export type CoreActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

const bootstrapCorePermissions = new Set([
  permissionKey("owner", "view"),
  permissionKey("owner", "create"),
  permissionKey("property", "view"),
  permissionKey("property", "create"),
  permissionKey("property", "edit")
]);

const bootstrapAgreementPermissions = new Set([
  ...bootstrapCorePermissions,
  permissionKey("config_rule", "view"),
  permissionKey("config_rule", "create"),
  permissionKey("config_rule", "configure")
]);

export function coreActorContextFromSession(session: Session | null): CoreActorContext | null {
  const user = session?.user;

  if (!user?.id || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    authContext: {
      organizationId: user.organizationId,
      permissions: bootstrapCorePermissions,
      scopes: [{ organizationId: user.organizationId }]
    }
  };
}

export async function agreementActorContextFromSession(session: Session | null): Promise<CoreActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.organizationId) {
    return null;
  }

  const accountContext = await authContextForAccount(user.organizationId, user.id);
  const permissions =
    accountContext.permissions.size > 0 ? accountContext.permissions : bootstrapAgreementPermissions;

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    authContext: {
      ...accountContext,
      permissions,
      scopes: accountContext.scopes.length > 0 ? accountContext.scopes : [{ organizationId: user.organizationId }]
    }
  };
}
