import type { Session } from "next-auth";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";

export type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

const bootstrapFinancePermissions = new Set([
  permissionKey("reservation", "view"),
  permissionKey("financial_transaction", "view"),
  permissionKey("financial_transaction", "create"),
  permissionKey("financial_transaction", "void"),
  permissionKey("financial_transaction", "reconcile")
]);

export function financeActorContextFromSession(session: Session | null): FinanceActorContext | null {
  const user = session?.user;

  if (!user?.id || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    authContext: {
      organizationId: user.organizationId,
      permissions: bootstrapFinancePermissions,
      scopes: [{ organizationId: user.organizationId }]
    }
  };
}
