import {
  authorize,
  type Action,
  type AuthContext,
  type DataClass,
  type Resource
} from "@/platform/authz/authorize";

export const maskedValue = "••••••";

export type FieldMaskMode = "placeholder" | "omit";

export type FieldPolicyRule<TResource extends Record<string, unknown>> = {
  dataClass: DataClass;
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
  rule: FieldPolicyRule<TResource>
): boolean {
  if (ctx.visibleDataClasses.has(rule.dataClass)) {
    return true;
  }

  if (ctx.visibleFields?.has(`${resource.type}.${field}`)) {
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
  policy: FieldPolicy<TResource>
): Partial<TResource> {
  if (!authorize(ctx, action, resource)) {
    throw new Error("Not authorized to present resource");
  }

  const output: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(resource.data) as Array<
    [keyof TResource & string, TResource[keyof TResource]]
  >) {
    const rule = policy[field];

    if (!rule || canSeeField(ctx, resource, field, rule)) {
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
