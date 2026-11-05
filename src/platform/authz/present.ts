import {
  authorize,
  assignmentCandidates,
  type Action,
  type AuthContext,
  type DataClass,
  type Resource
} from "@/platform/authz/authorize";
import { fieldPolicyCatalog, permissionActions, permissionResources } from "@/platform/authz/catalog";

export const maskedValue = "\u2022\u2022\u2022\u2022\u2022\u2022";

export type FieldMaskMode = "placeholder" | "omit";

export type FieldPolicyRule<TResource extends Record<string, unknown>> = {
  dataClass: DataClass;
  requiredPermission?: string;
  mask?: FieldMaskMode;
  selfField?: keyof TResource & string;
};

export type FieldPolicy<TResource extends Record<string, unknown>> = Partial<
  Record<keyof TResource & string, FieldPolicyRule<TResource>>
>;

export type PresentationContext = AuthContext & {
  visibleDataClasses: ReadonlySet<DataClass>;
  visibleFields?: ReadonlySet<string>;
  subjectPersonId?: string;
};

export type PresentableResource<TResource extends Record<string, unknown>> = Resource & {
  data: TResource;
};

function canSeeField<TResource extends Record<string, unknown>>(
  ctx: PresentationContext,
  resource: PresentableResource<TResource>,
  field: keyof TResource & string,
  rule: FieldPolicyRule<TResource>,
  action: Action,
  effectiveAt: Date
): boolean {
  const requiredAllowed = () => {
    if (!rule.requiredPermission) return false;
    const [type, verb, extra] = rule.requiredPermission.split(":");
    if (extra !== undefined || !permissionResources.some(resource => resource === type) || !permissionActions.some(action => action === verb)) return false;
    const source = { ...resource, type, dataClass: rule.dataClass };
    const dated = source.occurredAt instanceof Date ? Number.isFinite(source.occurredAt.getTime())
      : typeof source.occurredAt === "string" && Number.isFinite(Date.parse(source.occurredAt));
    const candidates = rule.dataClass === "financial" && !dated ? assignmentCandidates(ctx).filter(assignment =>
      !assignment.conditions?.timeWindow?.startsAt && !assignment.conditions?.timeWindow?.endsAt) : null;
    const authority = candidates ? { ...ctx, assignments: candidates, scopes: candidates.map(assignment => assignment.scope),
      permissions: new Set(candidates.flatMap(assignment => [...assignment.permissions])) } : ctx;
    return authorize(authority, verb as Action, source, effectiveAt) && (action !== "export" || verb === "export" || authorize(authority, "export", source, effectiveAt));
  };
  // A class label cannot replace the financial source's assignment, amount or export grant.
  if (rule.dataClass === "financial" && rule.requiredPermission) return requiredAllowed();
  if (ctx.visibleDataClasses.has(rule.dataClass)) {
    return true;
  }

  if (ctx.visibleFields?.has(`${resource.type}.${field}`)) {
    return true;
  }

  if (requiredAllowed()) {
    return true;
  }

  if (rule.selfField && ctx.subjectPersonId && resource.data[rule.selfField] === ctx.subjectPersonId) {
    return true;
  }

  return false;
}

export function present<TResource extends Record<string, unknown>>(
  ctx: PresentationContext,
  action: Action,
  resource: PresentableResource<TResource>,
  policy: FieldPolicy<TResource>,
  effectiveAt?: Date
): Partial<TResource> {
  const at = effectiveAt ?? new Date();
  if (!authorize(ctx, action, resource, at)) {
    throw new Error("Not authorized to present resource");
  }

  const output: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(resource.data) as Array<
    [keyof TResource & string, TResource[keyof TResource]]
  >) {
    const rule = policy[field];

    if (!rule || canSeeField(ctx, resource, field, rule, action, at)) {
      output[field] = value;
      continue;
    }

    if (rule.mask === "omit") {
      continue;
    }

    output[field] = maskedValue;
  }

  return output as Partial<TResource>;
}

export function catalogFieldPolicy<TResource extends Record<string, unknown>>(
  resourceType: string
): FieldPolicy<TResource> {
  const policy: FieldPolicy<TResource> = {};

  for (const rule of fieldPolicyCatalog) {
    if (rule.resource !== resourceType) {
      continue;
    }

    policy[rule.field as keyof TResource & string] = {
      dataClass: rule.dataClass,
      requiredPermission: rule.requiredPermission,
      mask: rule.mask
    };
  }

  return policy;
}
