import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";

export type ConfigActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

const bootstrapConfigPermissions = new Set([
  permissionKey("config_rule", "view"),
  permissionKey("config_rule", "create"),
  permissionKey("config_rule", "configure")
]);

export async function configActorContextFromSession(
  session: Session | null
): Promise<ConfigActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  const accountContext = await authContextForAccount(user.organizationId, user.id);
  const permissions =
    accountContext.permissions.size > 0 ? accountContext.permissions : bootstrapConfigPermissions;

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      ...accountContext,
      personId: user.personId,
      permissions,
      scopes: accountContext.scopes.length > 0 ? accountContext.scopes : [{ organizationId: user.organizationId }]
    }
  };
}
