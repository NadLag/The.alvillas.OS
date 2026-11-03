import { authorize, type Action, type AuthContext, type Resource, type Scope } from "./authorize";

/** Complete history requires an unconditional grant at the actual source scope. */
export function authorizeUnconditionalSource(ctx: AuthContext, action: Action, resource: Resource, now: Date, organizationOnly=false) {
  const organizationScope = (scope: Scope) => (scope.scopeType ?? scope.resourceType) === "organization";
  if (ctx.assignments) {
    const assignments = ctx.assignments.filter(assignment => (!organizationOnly||organizationScope(assignment.scope)) &&
      (!assignment.conditions || Object.keys(assignment.conditions).length === 0));
    return assignments.length > 0 && authorize({ ...ctx, assignments }, action, resource, now);
  }
  const scopes = organizationOnly?ctx.scopes.filter(organizationScope):ctx.scopes;
  return scopes.length > 0 && authorize({ ...ctx, scopes }, action, resource, now);
}

/** A complete organization source cannot be assembled from conditional or narrower grants. */
export function authorizeOrganizationSource(ctx: AuthContext, action: Action, resource: Resource, now: Date) {
  return authorizeUnconditionalSource(ctx,action,resource,now,true);
}
