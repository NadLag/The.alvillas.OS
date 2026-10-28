import { authorize, type Action, type AuthContext, type Resource, type Scope } from "./authorize";

/** A complete organization source cannot be assembled from conditional or narrower grants. */
export function authorizeOrganizationSource(ctx: AuthContext, action: Action, resource: Resource, now: Date) {
  const organizationScope = (scope: Scope) => (scope.scopeType ?? scope.resourceType) === "organization";
  if (ctx.assignments) {
    const assignments = ctx.assignments.filter(assignment => organizationScope(assignment.scope) &&
      (!assignment.conditions || Object.keys(assignment.conditions).length === 0));
    return assignments.length > 0 && authorize({ ...ctx, assignments }, action, resource, now);
  }
  const scopes = ctx.scopes.filter(organizationScope);
  return scopes.length > 0 && authorize({ ...ctx, scopes }, action, resource, now);
}
