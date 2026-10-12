import Decimal from "decimal.js";

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

export type ScopeType =
  | "organization"
  | "region"
  | "city"
  | "property"
  | "owner"
  | "reservation"
  | "job"
  | "service"
  | "financial_record"
  | "wallet"
  | "field_team";

export type Scope = {
  organizationId: string;
  scopeType?: ScopeType;
  scopeId?: string;
  resourceType?: string;
  resourceId?: string;
};

export type AuthorizationConditions = {
  assignedToMe?: boolean;
  statuses?: readonly string[];
  maxAmount?: string | number;
  timeWindow?: {
    startsAt?: Date | string;
    endsAt?: Date | string;
  };
};

export type AuthAssignment = {
  roleKey?: string;
  permissions: ReadonlySet<string>;
  scope: Scope;
  conditions?: AuthorizationConditions;
  validFrom?: Date;
  validTo?: Date | null;
};

export type AuthContext = {
  organizationId: string;
  userAccountId?: string;
  personId?: string;
  permissions: ReadonlySet<string>;
  scopes: readonly Scope[];
  assignments?: readonly AuthAssignment[];
};

export type Resource = {
  type: string;
  organizationId: string;
  id?: string;
  dataClass?: DataClass;
  region?: string | null;
  city?: string | null;
  propertyId?: string | null;
  ownerId?: string | null;
  reservationId?: string | null;
  jobId?: string | null;
  taskId?: string | null;
  serviceId?: string | null;
  financialRecordId?: string | null;
  walletId?: string | null;
  fieldTeamId?: string | null;
  assignedUserAccountId?: string | null;
  assignedPersonId?: string | null;
  status?: string | null;
  amount?: string | number | null;
  occurredAt?: Date | string | null;
};

export function permissionKey(resourceType: string, action: Action): string {
  return `${resourceType}:${action}`;
}

export function parseAuthorizationConditions(value: unknown): AuthorizationConditions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const conditions: AuthorizationConditions = {};

  if (typeof input.assignedToMe === "boolean") {
    conditions.assignedToMe = input.assignedToMe;
  }

  if (Array.isArray(input.statuses)) {
    conditions.statuses = input.statuses.filter((status): status is string => typeof status === "string");
  }

  if (typeof input.maxAmount === "string" || typeof input.maxAmount === "number") {
    conditions.maxAmount = input.maxAmount;
  }

  if (input.timeWindow && typeof input.timeWindow === "object" && !Array.isArray(input.timeWindow)) {
    const timeWindow = input.timeWindow as Record<string, unknown>;
    conditions.timeWindow = {};
    if (typeof timeWindow.startsAt === "string" || timeWindow.startsAt instanceof Date) {
      conditions.timeWindow.startsAt = timeWindow.startsAt;
    }
    if (typeof timeWindow.endsAt === "string" || timeWindow.endsAt instanceof Date) {
      conditions.timeWindow.endsAt = timeWindow.endsAt;
    }
  }

  return Object.keys(conditions).length > 0 ? conditions : undefined;
}

function scopeType(scope: Scope): ScopeType {
  return (scope.scopeType ?? scope.resourceType ?? "organization") as ScopeType;
}

function scopeId(scope: Scope): string | undefined {
  return scope.scopeId ?? scope.resourceId;
}

function assignmentCandidates(ctx: AuthContext): readonly AuthAssignment[] {
  if (ctx.assignments && ctx.assignments.length > 0) {
    return ctx.assignments;
  }

  return ctx.scopes.map((scope) => ({
    permissions: ctx.permissions,
    scope
  }));
}

function matchesResourceId(resource: Resource, ids: readonly (string | null | undefined)[]): boolean {
  return ids.some((id) => Boolean(id) && id === resource.id);
}

function scopeMatchesResource(scope: Scope, resource: Resource): boolean {
  const type = scopeType(scope);
  const id = scopeId(scope);
  const knownScopeTypes = new Set<string>([
    "organization",
    "region",
    "city",
    "property",
    "owner",
    "reservation",
    "job",
    "service",
    "financial_record",
    "wallet",
    "field_team"
  ]);

  if (scope.organizationId !== resource.organizationId) {
    return false;
  }

  if (!scope.scopeType && scope.resourceType && !knownScopeTypes.has(scope.resourceType)) {
    return scope.resourceType === resource.type && (!id || id === resource.id);
  }

  if (type === "organization") {
    return true;
  }

  if (!id) {
    return true;
  }

  switch (type) {
    case "region":
      return resource.region === id;
    case "city":
      return resource.city === id;
    case "property":
      return resource.propertyId === id || matchesResourceId(resource, [id]);
    case "owner":
      return resource.ownerId === id || matchesResourceId(resource, [id]);
    case "reservation":
      return resource.reservationId === id || matchesResourceId(resource, [id]);
    case "job":
      return resource.jobId === id || resource.taskId === id || matchesResourceId(resource, [id]);
    case "service":
      return resource.serviceId === id || matchesResourceId(resource, [id]);
    case "financial_record":
      return resource.financialRecordId === id || matchesResourceId(resource, [id]);
    case "wallet":
      return resource.walletId === id || matchesResourceId(resource, [id]);
    case "field_team":
      return resource.fieldTeamId === id;
  }
}

function conditionDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function conditionsMatch(
  ctx: AuthContext,
  assignment: AuthAssignment,
  resource: Resource,
  now = new Date()
): boolean {
  if (assignment.validFrom && assignment.validFrom.getTime() > now.getTime()) {
    return false;
  }

  if (assignment.validTo && assignment.validTo.getTime() <= now.getTime()) {
    return false;
  }

  const conditions = assignment.conditions;

  if (!conditions) {
    return true;
  }

  if (conditions.assignedToMe) {
    const matchesAccount =
      Boolean(ctx.userAccountId) && resource.assignedUserAccountId === ctx.userAccountId;
    const matchesPerson = Boolean(ctx.personId) && resource.assignedPersonId === ctx.personId;

    if (!matchesAccount && !matchesPerson) {
      return false;
    }
  }

  if (conditions.statuses && conditions.statuses.length > 0) {
    if (!resource.status || !conditions.statuses.includes(resource.status)) {
      return false;
    }
  }

  if (conditions.maxAmount !== undefined) {
    if (resource.amount === null || resource.amount === undefined) {
      return false;
    }

    if (new Decimal(resource.amount).gt(new Decimal(conditions.maxAmount))) {
      return false;
    }
  }

  if (conditions.timeWindow) {
    const occurredAt = conditionDate(resource.occurredAt) ?? now;
    const startsAt = conditionDate(conditions.timeWindow.startsAt);
    const endsAt = conditionDate(conditions.timeWindow.endsAt);

    if (startsAt && occurredAt.getTime() < startsAt.getTime()) {
      return false;
    }

    if (endsAt && occurredAt.getTime() > endsAt.getTime()) {
      return false;
    }
  }

  return true;
}

export function hasPermission(ctx: AuthContext, action: Action, resourceType: string): boolean {
  return ctx.permissions.has(permissionKey(resourceType, action));
}

export function authorizeCollection(ctx: AuthContext, action: Action, resourceType: string): boolean {
  if (!hasPermission(ctx, action, resourceType)) {
    return false;
  }

  return assignmentCandidates(ctx).some((assignment) =>
    assignment.permissions.has(permissionKey(resourceType, action))
  );
}

export function authorize(ctx: AuthContext, action: Action, resource: Resource): boolean {
  if (ctx.organizationId !== resource.organizationId) {
    return false;
  }

  const key = permissionKey(resource.type, action);

  if (!ctx.permissions.has(key)) {
    return false;
  }

  return assignmentCandidates(ctx).some(
    (assignment) =>
      assignment.permissions.has(key) &&
      scopeMatchesResource(assignment.scope, resource) &&
      conditionsMatch(ctx, assignment, resource)
  );
}
