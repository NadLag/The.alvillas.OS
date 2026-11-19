import { z } from "zod";
import { authorize, permissionKey, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { present, type FieldPolicy } from "@/platform/authz/present";

export const householdAreas = [
  "income", "expenses", "budgets", "savings", "investments", "positions", "documents", "reports", "transfers"
] as const;
export type HouseholdArea = (typeof householdAreas)[number];
const readGrants = householdAreas.map((area) => `${area}:view` as const);
const editGrants = householdAreas.filter((area) => area !== "reports").map((area) => `${area}:edit` as const);
export const householdGrants = [...readGrants, ...editGrants] as const;
const grantSchema = z.enum(householdGrants);
export type HouseholdGrant = z.infer<typeof grantSchema>;
export const householdIdSchema = z.uuid();

export const householdMemberSchema = z.object({
  accountId: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  isChild: z.boolean(),
  grants: z.array(grantSchema).max(householdGrants.length).transform((grants) => [...new Set(grants)].sort())
}).strict().refine(({ grants }) => grants.every((grant) => !grant.endsWith(":edit") || grants.some(
  (candidate) => candidate === grant.replace(/:edit$/u, ":view")
)));

export type HouseholdIdentity = { organizationId: string; accountId: string };
export type HouseholdMember = HouseholdIdentity & {
  householdId: string;
  isSteward: boolean;
  isChild: boolean;
  grants: readonly string[];
  revokedAt: Date | null;
};

type HouseholdResource = HouseholdArea | "household" | "members" | "audit";
export function personalResource(organizationId: string, householdId: string, area: HouseholdResource): Resource {
  return { organizationId, id: householdId, type: `personal_${area}`, dataClass: "personal" };
}

export function householdAuthority(identity: HouseholdIdentity, member: HouseholdMember | null): AuthContext {
  const permissions = new Set<string>();
  const scopes: AuthContext["scopes"][number][] = [];
  if (member && !member.revokedAt && member.organizationId === identity.organizationId && member.accountId === identity.accountId) {
    const steward = member.isSteward && !member.isChild;
    permissions.add(permissionKey("personal_household", "view"));
    const addScope = (area: HouseholdResource) => scopes.push({
      organizationId: identity.organizationId, resourceType: `personal_${area}`, resourceId: member.householdId
    });
    addScope("household");
    for (const area of householdAreas) {
      const reads = steward || member.grants.includes(`${area}:view`);
      if (!reads) continue;
      addScope(area);
      permissions.add(permissionKey(`personal_${area}`, "view"));
      if (area !== "reports" && (steward || member.grants.includes(`${area}:edit`))) {
        permissions.add(permissionKey(`personal_${area}`, "edit"));
      }
    }
    if (steward) {
      addScope("members");
      addScope("audit");
      permissions.add(permissionKey("personal_members", "view"));
      permissions.add(permissionKey("personal_members", "edit"));
      permissions.add(permissionKey("personal_audit", "view"));
    }
  }
  return { organizationId: identity.organizationId, userAccountId: identity.accountId, permissions, scopes };
}

export function canUseHousehold(context: AuthContext, householdId: string, area: HouseholdResource, action: "view" | "edit" = "view"): boolean {
  return authorize(context, action, personalResource(context.organizationId, householdId, area));
}

export function presentPersonal<T extends Record<string, unknown>>(
  context: AuthContext, householdId: string, area: HouseholdResource, data: T
) {
  const policy: FieldPolicy<T> = {};
  for (const field of Object.keys(data) as (keyof T & string)[]) {
    policy[field] = { dataClass: "personal", mask: "omit" };
  }
  return present({ ...context, visibleDataClasses: new Set(["personal"]) }, "view", {
    ...personalResource(context.organizationId, householdId, area), data
  }, policy) as T;
}
