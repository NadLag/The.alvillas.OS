export type Action =
  | "view"
  | "create"
  | "edit"
  | "void"
  | "approve"
  | "reject"
  | "assign"
  | "validate"
  | "export"
  | "pay"
  | "reconcile"
  | "configure"
  | "override";

export type DataClass = "operational" | "guest" | "financial" | "personal" | "sensitive";

export type Scope = {
  organizationId: string;
  resourceType?: string;
  resourceId?: string;
};

export type AuthContext = {
  organizationId: string;
  permissions: ReadonlySet<string>;
  scopes: readonly Scope[];
};

export type Resource = {
  type: string;
  organizationId: string;
  id?: string;
  dataClass?: DataClass;
};

export function permissionKey(resourceType: string, action: Action): string {
  return `${resourceType}:${action}`;
}

export function authorize(ctx: AuthContext, action: Action, resource: Resource): boolean {
  if (ctx.organizationId !== resource.organizationId) {
    return false;
  }

  if (!ctx.permissions.has(permissionKey(resource.type, action))) {
    return false;
  }

  return ctx.scopes.some((scope) => {
    if (scope.organizationId !== resource.organizationId) {
      return false;
    }

    if (!scope.resourceType) {
      return true;
    }

    if (scope.resourceType !== resource.type) {
      return false;
    }

    return !scope.resourceId || scope.resourceId === resource.id;
  });
}
