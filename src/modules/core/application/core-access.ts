import type { Session } from "next-auth";
import { authContextForAccount } from "@/platform/authz/account-context";
import type { AuthContext } from "@/platform/authz/authorize";

export class TemplateAccessError extends Error {}
export class TemplateConflictError extends Error {}
export class TemplateNotFoundError extends Error {}

export class CoreAuthorizationError extends Error {
  constructor(message = "Core action is not authorized") {super(message);this.name="CoreAuthorizationError";}
}
export class CoreNotFoundError extends Error {
  constructor(message = "Core resource was not found") {super(message);this.name="CoreNotFoundError";}
}
export class CoreValidationError extends Error {
  constructor(message = "Core input is invalid") {super(message);this.name="CoreValidationError";}
}

export class TemplateAccessError extends Error {}
export class TemplateConflictError extends Error {}
export class TemplateNotFoundError extends Error {}

export type CoreActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

export async function coreActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<CoreActorContext | null> {
  const user = session?.user;
  if (!user?.id || !user.personId || !user.organizationId || user.securitySetupRequired || user.sessionRevoked) return null;
  return { organizationId: user.organizationId, actorId: user.id,
    authContext: { ...(await authContextForAccount(user.organizationId, user.id, deps)), personId: user.personId } };
}

export async function agreementActorContextFromSession(
  session: Session | null,
  deps: Parameters<typeof authContextForAccount>[2] = {}
): Promise<CoreActorContext | null> {
  return coreActorContextFromSession(session, deps);
}
