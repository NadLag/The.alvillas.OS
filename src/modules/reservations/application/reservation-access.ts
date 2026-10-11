import type { Session } from "next-auth";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";

export type ReservationActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

const bootstrapReservationPermissions = new Set([
  permissionKey("reservation", "view"),
  permissionKey("reservation", "create"),
  permissionKey("task", "view"),
  permissionKey("task", "create"),
  permissionKey("task", "edit"),
  permissionKey("task", "validate")
]);

export function reservationActorContextFromSession(
  session: Session | null
): ReservationActorContext | null {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      organizationId: user.organizationId,
      permissions: bootstrapReservationPermissions,
      scopes: [{ organizationId: user.organizationId }]
    }
  };
}
