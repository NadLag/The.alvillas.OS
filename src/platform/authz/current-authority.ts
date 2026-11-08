import { authorize, type Action, type AuthContext, type Resource } from "./authorize";
import { authContextForAccountInTransaction } from "./account-context";
import { authorizeOrganizationSource,authorizeUnconditionalSource } from "./organization-authority";
import type { TenantTransaction } from "@/platform/db/tenant";

export type CurrentAuthorityCheck = { action: Action; resource: Resource; organizationOnly?: boolean; unconditional?:boolean };

/** Apply the same held/stored restriction to an already loaded native read snapshot. */
export function assertAccountAuthorization(
  ctx:{organizationId:string;actorId:string;authContext:AuthContext},stored:AuthContext,now:Date,
  checks:readonly CurrentAuthorityCheck[],denied:Error
) {
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId||stored.organizationId!==ctx.organizationId||stored.userAccountId!==ctx.actorId)throw denied;
  const current={...stored,personId:ctx.authContext.personId};
  if(checks.some(({action,resource,organizationOnly,unconditional})=>resource.organizationId!==ctx.organizationId||
    [ctx.authContext,current].some(authority=>!(organizationOnly?authorizeOrganizationSource(authority,action,resource,now):unconditional?authorizeUnconditionalSource(authority,action,resource,now):authorize(authority,action,resource,now)))))throw denied;
}

/** Locks never extend a caller's grant: require both its restrictions and stored authority. */
export async function recheckAccountAuthorization(
  ctx: { organizationId: string; actorId: string; authContext: AuthContext }, tx: TenantTransaction, now: Date,
  checks: readonly CurrentAuthorityCheck[], denied: Error
) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw denied;
  assertAccountAuthorization(ctx,await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now,checks,denied);
}
