import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  completeChecklist,
  createTaskSchema,
  proxyCompleteTaskSchema,
  taskStates,
  propertyInstant,
  taskQuerySchema,
} from "@/modules/reservations/domain/operation-task";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { taskDateRange } from "@/modules/reservations/application/operation-management";
describe("operational task invariants", () => {
  it("uses property time, rejects nonexistent local times and intersects calendar date filters", () => {
    expect(propertyInstant("2027-04-10", 540, "Asia/Dubai").toISOString()).toBe(
      "2027-04-10T05:00:00.000Z",
    );
    expect(() =>
      propertyInstant("2027-03-14", 150, "America/New_York"),
    ).toThrow("operation_local_time_unavailable");
    expect(
      taskQuerySchema.parse({ date: "", from: "", until: "" }).date,
    ).toBeUndefined();
    const now = new Date("2027-04-01T00:00:00Z");
    expect(
      taskDateRange(
        taskQuerySchema.parse({
          view: "WEEK",
          from: "2027-04-10",
          until: "2027-04-11",
        }),
        now,
      ),
    ).toEqual({ from: "2027-04-10", until: "2027-04-11" });
    expect(
      taskDateRange(
        taskQuerySchema.parse({ view: "DAY" }),
        now,
        "America/Los_Angeles",
      ),
    ).toEqual({ from: "2027-03-31", until: "2027-03-31" });
  });
  it("permits only explicit transitions and never reopens terminal work", () => {
    expect(canTransitionTask("PLANNED", "ASSIGNED")).toBe(true);
    expect(canTransitionTask("ASSIGNED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionTask("IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(canTransitionTask("PLANNED", "COMPLETED")).toBe(false);
    for (const from of ["COMPLETED", "CANCELLED", "SKIPPED"])
      for (const to of taskStates)
        expect(canTransitionTask(from, to)).toBe(false);
  });
  it("requires exact checklist coverage, rejecting foreign and duplicate items", () => {
    const checklist = [{ id: "a" }, { id: "b" }];
    expect(completeChecklist(checklist, ["a", "b"])).toBe(true);
    expect(completeChecklist(checklist, ["a", "a", "b"])).toBe(false);
    expect(completeChecklist(checklist, ["a", "c"])).toBe(false);
  });
  it("accepts the complete operational type catalog and validates calendar dates", () => {
    for (const type of [
      "CLEANING",
      "LAUNDRY",
      "INVENTORY",
      "CHEF",
      "TRANSFER",
      "CUSTOM",
      "INSPECTION",
      "POOL",
      "GARDEN",
      "MAINTENANCE",
    ])
      expect(taskTypeSchema.safeParse(type).success).toBe(true);
    expect(createTaskSchema.safeParse({}).success).toBe(false);
    expect(proxyCompleteTaskSchema.safeParse({ reason: "" }).success).toBe(
      false,
    );
  });
});
