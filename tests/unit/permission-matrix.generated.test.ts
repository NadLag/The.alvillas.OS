import { describe, expect, it } from "vitest";
import {
  authContextForMatrixCase,
  permissionMatrixCases,
  permissionMatrixFixtures
} from "@/platform/authz/permission-matrix";
import { authorize } from "@/platform/authz/authorize";
import { simulateAccess, splitSimulationResults } from "@/platform/authz/simulator";

describe("generated permission matrix", () => {
  it("generates assigned and out-of-scope cases for every standard role permission entry", () => {
    expect(permissionMatrixFixtures.catalogCaseCount).toBe(
      permissionMatrixFixtures.standardRoleCount * permissionMatrixFixtures.permissionCount * 2
    );
  });

  it.each(permissionMatrixCases)(
    "$roleKey $scenarioKey is $expected",
    ({ roleKey, scenario, expected }) => {
      expect(authorize(authContextForMatrixCase(roleKey), scenario.action, scenario.resource)).toBe(
        expected
      );
    }
  );

  it("proves the co-host example from the specification", () => {
    const coHostCases = permissionMatrixCases.filter(
      (testCase) => testCase.roleKey === "co_host" && testCase.scenarioKey.startsWith("spec:")
    );
    const results = splitSimulationResults(
      simulateAccess(
        authContextForMatrixCase("co_host"),
        coHostCases.map((testCase) => testCase.scenario)
      )
    );

    expect(results.canSee.map((result) => result.key).sort()).toEqual([
      "assigned-property",
      "assigned-reservations",
      "assigned-tasks"
    ]);
    expect(results.cannotSee.map((result) => result.key).sort()).toEqual([
      "other-property",
      "other-wallet",
      "portfolio-revenue"
    ]);
  });
});
