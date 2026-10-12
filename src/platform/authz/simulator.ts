import { authorize, type Action, type AuthContext, type Resource } from "@/platform/authz/authorize";

export type PermissionSimulationScenario = {
  key: string;
  label: string;
  action: Action;
  resource: Resource;
};

export type PermissionSimulationResult = PermissionSimulationScenario & {
  allowed: boolean;
};

export function simulateAccess(
  ctx: AuthContext,
  scenarios: readonly PermissionSimulationScenario[]
): PermissionSimulationResult[] {
  return scenarios.map((scenario) => ({
    ...scenario,
    allowed: authorize(ctx, scenario.action, scenario.resource)
  }));
}

export function splitSimulationResults(results: readonly PermissionSimulationResult[]): {
  canSee: PermissionSimulationResult[];
  cannotSee: PermissionSimulationResult[];
} {
  return {
    canSee: results.filter((result) => result.allowed),
    cannotSee: results.filter((result) => !result.allowed)
  };
}

export function coHostSpecScenarios(input: {
  organizationId: string;
  assignedPropertyId: string;
  otherPropertyId: string;
  reservationId: string;
  walletId: string;
}): PermissionSimulationScenario[] {
  return [
    {
      key: "assigned-property",
      label: "Assigned property",
      action: "view",
      resource: {
        type: "property",
        organizationId: input.organizationId,
        id: input.assignedPropertyId,
        propertyId: input.assignedPropertyId,
        dataClass: "operational"
      }
    },
    {
      key: "assigned-reservations",
      label: "Assigned property reservations",
      action: "view",
      resource: {
        type: "reservation",
        organizationId: input.organizationId,
        id: input.reservationId,
        reservationId: input.reservationId,
        propertyId: input.assignedPropertyId,
        dataClass: "guest"
      }
    },
    {
      key: "assigned-tasks",
      label: "Assigned property tasks",
      action: "view",
      resource: {
        type: "task",
        organizationId: input.organizationId,
        id: "sim-task",
        taskId: "sim-task",
        propertyId: input.assignedPropertyId,
        dataClass: "operational"
      }
    },
    {
      key: "portfolio-revenue",
      label: "Portfolio revenue",
      action: "view",
      resource: {
        type: "financial_transaction",
        organizationId: input.organizationId,
        id: "sim-revenue",
        financialRecordId: "sim-revenue",
        propertyId: input.assignedPropertyId,
        amount: "8000.00",
        dataClass: "financial"
      }
    },
    {
      key: "other-property",
      label: "Other property",
      action: "view",
      resource: {
        type: "property",
        organizationId: input.organizationId,
        id: input.otherPropertyId,
        propertyId: input.otherPropertyId,
        dataClass: "operational"
      }
    },
    {
      key: "other-wallet",
      label: "Other staff wallet",
      action: "view",
      resource: {
        type: "wallet",
        organizationId: input.organizationId,
        id: input.walletId,
        walletId: input.walletId,
        propertyId: input.otherPropertyId,
        dataClass: "financial"
      }
    }
  ];
}
