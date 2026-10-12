import {
  permissionCatalog,
  standardRoleTemplates,
  type PermissionCatalogEntry,
  type StandardRoleKey,
  type StandardRoleTemplate
} from "@/platform/authz/catalog";
import {
  type AuthContext,
  type Resource,
  type Scope,
  type ScopeType
} from "@/platform/authz/authorize";
import { coHostSpecScenarios, type PermissionSimulationScenario } from "@/platform/authz/simulator";

const organizationId = "matrix-org";
const assignedCity = "Marrakech";
const otherCity = "Essaouira";
const assignedPropertyId = "matrix-property-assigned";
const otherPropertyId = "matrix-property-other";
const assignedOwnerId = "matrix-owner-assigned";
const otherOwnerId = "matrix-owner-other";
const assignedReservationId = "matrix-reservation-assigned";
const otherReservationId = "matrix-reservation-other";
const assignedJobId = "matrix-task";
const otherJobId = "matrix-task-other";
const assignedServiceId = "matrix-service-assigned";
const otherServiceId = "matrix-service-other";
const assignedFinancialRecordId = "matrix-financial-record-assigned";
const otherFinancialRecordId = "matrix-financial-record-other";
const assignedWalletId = "matrix-wallet-assigned";
const otherWalletId = "matrix-wallet-other";
const assignedFieldTeamId = "matrix-field-team-assigned";
const otherFieldTeamId = "matrix-field-team-other";
const workerAccountId = "matrix-worker";
const workerPersonId = "matrix-worker-person";

type MatrixScopeProfile = "organization" | "city" | "property" | "owner" | "job" | "service";
type ScopeVariant = "assigned" | "other";

const roleScopeProfiles: Record<StandardRoleKey, MatrixScopeProfile> = {
  admin: "organization",
  operations_manager: "city",
  property_manager: "property",
  co_host: "property",
  field_staff: "job",
  housekeeper: "job",
  pool_technician: "job",
  gardener: "job",
  maintenance: "job",
  chef: "service",
  driver: "job",
  qa_inspector: "property",
  finance: "organization",
  accountant: "organization",
  procurement: "organization",
  guest_experience: "property",
  revenue_manager: "property",
  regional_manager: "city",
  contractor: "job",
  temporary_worker: "job",
  owner: "owner",
  owner_representative: "owner"
};

export type PermissionMatrixCase = {
  roleKey: StandardRoleKey;
  scenarioKey: string;
  expected: boolean;
  scenario: PermissionSimulationScenario;
};

function templateByKey(key: StandardRoleKey): StandardRoleTemplate {
  const role = standardRoleTemplates.find((template) => template.key === key);

  if (!role) {
    throw new Error(`Missing standard role template: ${key}`);
  }

  return role;
}

function scopeForProfile(profile: MatrixScopeProfile): Scope {
  switch (profile) {
    case "organization":
      return { organizationId, scopeType: "organization" };
    case "city":
      return { organizationId, scopeType: "city", scopeId: assignedCity };
    case "property":
      return { organizationId, scopeType: "property", scopeId: assignedPropertyId };
    case "owner":
      return { organizationId, scopeType: "owner", scopeId: assignedOwnerId };
    case "job":
      return { organizationId, scopeType: "job", scopeId: assignedJobId };
    case "service":
      return { organizationId, scopeType: "service", scopeId: assignedServiceId };
  }
}

function resourceForPermission(permission: PermissionCatalogEntry, variant: ScopeVariant): Resource {
  const assigned = variant === "assigned";
  const propertyId = assigned ? assignedPropertyId : otherPropertyId;
  const ownerId = assigned ? assignedOwnerId : otherOwnerId;
  const reservationId = assigned ? assignedReservationId : otherReservationId;
  const jobId = assigned ? assignedJobId : otherJobId;
  const serviceId = assigned ? assignedServiceId : otherServiceId;
  const financialRecordId = assigned ? assignedFinancialRecordId : otherFinancialRecordId;
  const walletId = assigned ? assignedWalletId : otherWalletId;
  const fieldTeamId = assigned ? assignedFieldTeamId : otherFieldTeamId;

  return {
    type: permission.resource,
    organizationId,
    id: `${permission.resource}-${variant}`,
    city: assigned ? assignedCity : otherCity,
    propertyId,
    ownerId,
    reservationId,
    taskId: jobId,
    jobId,
    serviceId,
    financialRecordId,
    walletId,
    fieldTeamId,
    assignedUserAccountId: assigned ? workerAccountId : "matrix-other-worker",
    assignedPersonId: assigned ? workerPersonId : "matrix-other-person",
    status: "OPEN",
    amount: "1000.00"
  };
}

function scopeAllows(profile: MatrixScopeProfile, variant: ScopeVariant, resource: Resource): boolean {
  if (profile === "organization") {
    return true;
  }

  if (variant !== "assigned") {
    return false;
  }

  switch (profile) {
    case "city":
      return resource.city === assignedCity;
    case "property":
      return resource.propertyId === assignedPropertyId || resource.id === assignedPropertyId;
    case "owner":
      return resource.ownerId === assignedOwnerId || resource.id === assignedOwnerId;
    case "job":
      return resource.jobId === assignedJobId || resource.taskId === assignedJobId || resource.id === assignedJobId;
    case "service":
      return resource.serviceId === assignedServiceId || resource.id === assignedServiceId;
  }
}

export function authContextForStandardRole(
  roleKey: StandardRoleKey,
  scopeType: ScopeType = "organization",
  scopeId?: string
): AuthContext {
  const role = templateByKey(roleKey);
  const scope =
    scopeType === "organization"
      ? { organizationId, scopeType: "organization" as const }
      : { organizationId, scopeType, scopeId };

  return {
    organizationId,
    permissions: new Set(role.permissions),
    scopes: [scope],
    assignments: [
      {
        roleKey,
        permissions: new Set(role.permissions),
        scope
      }
    ]
  };
}

export function authContextForMatrixCase(roleKey: StandardRoleKey): AuthContext {
  const role = templateByKey(roleKey);
  const profile = roleScopeProfiles[roleKey];
  const scope = scopeForProfile(profile);
  const isOwnWorkRole = profile === "job";

  return {
    organizationId,
    userAccountId: workerAccountId,
    personId: workerPersonId,
    permissions: new Set(role.permissions),
    scopes: [scope],
    assignments: [
      {
        roleKey,
        permissions: new Set(role.permissions),
        scope,
        conditions: isOwnWorkRole ? { assignedToMe: true } : undefined
      }
    ]
  };
}

const generatedCatalogCases = standardRoleTemplates.flatMap((role) => {
  const profile = roleScopeProfiles[role.key];
  const rolePermissions = new Set(role.permissions);

  return permissionCatalog.flatMap((permission) =>
    (["assigned", "other"] as const).map((variant) => {
      const scenario: PermissionSimulationScenario = {
        key: `${permission.key}:${variant}`,
        label: `${permission.key} ${variant}`,
        action: permission.action,
        resource: resourceForPermission(permission, variant)
      };

      return {
        roleKey: role.key,
        scenarioKey: scenario.key,
        scenario,
        expected: rolePermissions.has(permission.key) && scopeAllows(profile, variant, scenario.resource)
      };
    })
  );
});

const coHostScenarios = coHostSpecScenarios({
  organizationId,
  assignedPropertyId,
  otherPropertyId,
  reservationId: assignedReservationId,
  walletId: otherWalletId
});

export const permissionMatrixCases: readonly PermissionMatrixCase[] = [
  ...generatedCatalogCases,
  ...coHostScenarios.map((scenario) => ({
    roleKey: "co_host" as const,
    scenarioKey: `spec:${scenario.key}`,
    scenario,
    expected: ["assigned-property", "assigned-reservations", "assigned-tasks"].includes(scenario.key)
  }))
];

export const permissionMatrixFixtures = {
  organizationId,
  assignedPropertyId,
  otherPropertyId,
  reservationId: assignedReservationId,
  walletId: otherWalletId,
  catalogCaseCount: generatedCatalogCases.length,
  standardRoleCount: standardRoleTemplates.length,
  permissionCount: permissionCatalog.length
};
