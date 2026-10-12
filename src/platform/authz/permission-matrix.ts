import {
  standardRoleTemplates,
  type StandardRoleKey,
  type StandardRoleTemplate
} from "@/platform/authz/catalog";
import { type AuthContext, type ScopeType } from "@/platform/authz/authorize";
import { coHostSpecScenarios, type PermissionSimulationScenario } from "@/platform/authz/simulator";

const organizationId = "matrix-org";
const assignedPropertyId = "matrix-property-assigned";
const otherPropertyId = "matrix-property-other";
const reservationId = "matrix-reservation";
const walletId = "matrix-wallet-other";

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
  if (roleKey === "co_host" || roleKey === "owner") {
    return authContextForStandardRole(roleKey, "property", assignedPropertyId);
  }

  if (roleKey === "housekeeper") {
    const role = templateByKey(roleKey);
    const scope = { organizationId, scopeType: "job" as const, scopeId: "matrix-task" };

    return {
      organizationId,
      userAccountId: "matrix-worker",
      personId: "matrix-worker-person",
      permissions: new Set(role.permissions),
      scopes: [scope],
      assignments: [
        {
          roleKey,
          permissions: new Set(role.permissions),
          scope,
          conditions: { assignedToMe: true }
        }
      ]
    };
  }

  return authContextForStandardRole(roleKey);
}

const coHostScenarios = coHostSpecScenarios({
  organizationId,
  assignedPropertyId,
  otherPropertyId,
  reservationId,
  walletId
});

const financeRevenueScenario: PermissionSimulationScenario = {
  key: "finance-revenue",
  label: "Financial transaction",
  action: "view",
  resource: {
    type: "financial_transaction",
    organizationId,
    id: "matrix-financial-record",
    financialRecordId: "matrix-financial-record",
    amount: "1000.00",
    dataClass: "financial"
  }
};

const ownerStatementScenario: PermissionSimulationScenario = {
  key: "owner-statement",
  label: "Own owner statement",
  action: "view",
  resource: {
    type: "owner_statement",
    organizationId,
    id: assignedPropertyId,
    propertyId: assignedPropertyId,
    ownerId: "matrix-owner",
    dataClass: "financial"
  }
};

const assignedTaskScenario: PermissionSimulationScenario = {
  key: "assigned-task",
  label: "Assigned job",
  action: "edit",
  resource: {
    type: "task",
    organizationId,
    id: "matrix-task",
    taskId: "matrix-task",
    propertyId: assignedPropertyId,
    assignedUserAccountId: "matrix-worker",
    dataClass: "operational"
  }
};

export const permissionMatrixCases: readonly PermissionMatrixCase[] = [
  ...coHostScenarios.map((scenario) => ({
    roleKey: "co_host" as const,
    scenarioKey: scenario.key,
    scenario,
    expected: ["assigned-property", "assigned-reservations", "assigned-tasks"].includes(scenario.key)
  })),
  {
    roleKey: "finance",
    scenarioKey: financeRevenueScenario.key,
    scenario: financeRevenueScenario,
    expected: true
  },
  {
    roleKey: "operations_manager",
    scenarioKey: financeRevenueScenario.key,
    scenario: financeRevenueScenario,
    expected: false
  },
  {
    roleKey: "owner",
    scenarioKey: ownerStatementScenario.key,
    scenario: ownerStatementScenario,
    expected: true
  },
  {
    roleKey: "owner",
    scenarioKey: "other-property",
    scenario: {
      ...ownerStatementScenario,
      key: "other-property",
      label: "Other owner property statement",
      resource: {
        ...ownerStatementScenario.resource,
        id: otherPropertyId,
        propertyId: otherPropertyId
      }
    },
    expected: false
  },
  {
    roleKey: "housekeeper",
    scenarioKey: assignedTaskScenario.key,
    scenario: assignedTaskScenario,
    expected: true
  }
];

export const permissionMatrixFixtures = {
  organizationId,
  assignedPropertyId,
  otherPropertyId,
  reservationId,
  walletId
};
