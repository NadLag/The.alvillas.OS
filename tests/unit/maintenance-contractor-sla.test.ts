import { expect, it } from "vitest";
import { maintenanceSlaPolicySchema } from "@/platform/config/maintenance-sla-policy";
import { maintenanceSlaDeadlines, maintenanceSlaMilestone } from "@/modules/maintenance/domain/contractor-sla";

it("applies the effective priority's elapsed response and completion times", () => {
  const period = { response_minutes: 120, completion_minutes: 600 };
  const policy = maintenanceSlaPolicySchema.parse({ priorities: { LOW: period, NORMAL: period, HIGH: period,
    URGENT: { response_minutes: 15, completion_minutes: 60 } } });
  const assigned = new Date("2026-11-18T23:50:00.000Z");
  const urgent = maintenanceSlaDeadlines(assigned, policy, "URGENT");
  expect(urgent.responseDueAt.toISOString()).toBe("2026-11-19T00:05:00.000Z");
  expect(urgent.completionDueAt.toISOString()).toBe("2026-11-19T00:50:00.000Z");
  expect(maintenanceSlaDeadlines(assigned, policy, "HIGH").responseDueAt.toISOString()).toBe("2026-11-19T01:50:00.000Z");
  const overdue = new Date("2026-11-19T00:10:00.000Z");
  expect(maintenanceSlaMilestone(urgent.responseDueAt, null, overdue, false)).toBe("BREACHED");
  expect(maintenanceSlaMilestone(urgent.responseDueAt, urgent.responseDueAt, overdue, false)).toBe("MET");
  expect(maintenanceSlaMilestone(urgent.completionDueAt, null, overdue, true)).toBe("CANCELLED");
  expect(maintenanceSlaPolicySchema.safeParse({ priorities: { ...policy.priorities,
    HIGH: { response_minutes: 120, completion_minutes: 119 } } }).success).toBe(false);
});
