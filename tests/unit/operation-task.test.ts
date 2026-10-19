import { describe, expect, it } from "vitest";
import { canTransitionTask, completeChecklist, createTaskSchema, proxyCompleteTaskSchema, taskStates } from "@/modules/reservations/domain/operation-task";
import { taskTypeSchema } from "@/platform/config/rule-registry";
describe("operational task invariants", () => {
  it("permits only explicit transitions and never reopens terminal work", () => {
    expect(canTransitionTask("PLANNED", "ASSIGNED")).toBe(true);
    expect(canTransitionTask("ASSIGNED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionTask("IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(canTransitionTask("PLANNED", "COMPLETED")).toBe(false);
    for (const from of ["COMPLETED", "CANCELLED", "SKIPPED"]) for (const to of taskStates) expect(canTransitionTask(from, to)).toBe(false);
  });
  it("requires exact checklist coverage, rejecting foreign and duplicate items", () => {
    const checklist = [{ id: "a" }, { id: "b" }];
    expect(completeChecklist(checklist, ["a", "b"])).toBe(true);
    expect(completeChecklist(checklist, ["a", "a", "b"])).toBe(false);
    expect(completeChecklist(checklist, ["a", "c"])).toBe(false);
  });
  it("accepts the complete operational type catalog and validates calendar dates", () => {
    for (const type of ["CLEANING", "LAUNDRY", "INVENTORY", "CHEF", "TRANSFER", "CUSTOM", "INSPECTION", "POOL", "GARDEN", "MAINTENANCE"]) expect(taskTypeSchema.safeParse(type).success).toBe(true);
    expect(createTaskSchema.safeParse({}).success).toBe(false);
    expect(proxyCompleteTaskSchema.safeParse({ reason: "" }).success).toBe(false);
  });
});
