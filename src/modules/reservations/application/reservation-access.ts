import type { Session } from "next-auth";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";

export type ReservationActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

const bootstrapReservationPermissions = new Set([
  permissionKey("reservation", "view"),
  permissionKey("reservation", "create"),
  permissionKey("task", "view"),
  permissionKey("task", "create")
]);

export function reservationActorContextFromSession(
  session: Session | null
): ReservationActorContext | null {
  const user = session?.user;

  if (!user?.id || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    authContext: {
      organizationId: user.organizationId,
      permissions: bootstrapReservationPermissions,
      scopes: [{ organizationId: user.organizationId }]
    }
  };
}
