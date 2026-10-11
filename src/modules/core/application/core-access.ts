import type { Session } from "next-auth";
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
  permissionKey("property", "create")
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
