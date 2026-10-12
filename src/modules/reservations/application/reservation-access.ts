import type { Session } from "next-auth";
import { type AuthContext } from "@/platform/authz/authorize";
import { authContextForAccount } from "@/platform/authz/account-context";

export type ReservationActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

export async function reservationActorContextFromSession(
  session: Session | null
): Promise<ReservationActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: {
      ...(await authContextForAccount(user.organizationId, user.id)),
      personId: user.personId
    }
  };
}
