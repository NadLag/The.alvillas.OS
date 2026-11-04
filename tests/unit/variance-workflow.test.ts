import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decideVarianceWorkflow, projectVarianceWorkflow, varianceWorkflowCommandSchema, VarianceWorkflowConflictError, VarianceWorkflowSourceError,
  type VarianceWorkflowCommand, type VarianceWorkflowSource, type VarianceWorkflowState } from "@/modules/finance/domain/variance-workflow";

const actorId = randomUUID(), assignedTo = randomUUID(), now = new Date("2026-11-04T09:00:00Z");
const source = (): VarianceWorkflowSource => ({ source: { provider: "OTA", id: randomUUID() }, fingerprint: "a".repeat(64), state: "OPEN",
  createdAt: new Date("2026-11-01T09:00:00Z"), reason: "Original retained bank fee", action: "Review original settlement" });
function command(f: VarianceWorkflowSource, operation: VarianceWorkflowCommand["operation"], version = "0"): VarianceWorkflowCommand {
  const common = { source: f.source, version, sourceFingerprint: f.fingerprint, reason: "Record the actual reviewed variance workflow" };
  return operation === "ASSIGN" ? { ...common, operation, assignedTo } : { ...common, operation, action: "Review and record the actual retained action" };
}
function decide(f: VarianceWorkflowSource, intent: VarianceWorkflowCommand, latest: VarianceWorkflowState | null = null, assigneeEligible = true) {
  return decideVarianceWorkflow({ source: f, command: intent, latest, actorId, now, assigneeEligible });
}
describe("append-only reviewed variance workflow", () => {
  it("assigns, resolves with attributed trusted time and reopens without changing source facts or earlier states", () => {
    const f = source(), original = JSON.stringify(f), assigned = decide(f, command(f, "ASSIGN")), assignedBefore = JSON.stringify(assigned);
    const resolved = decide(f, command(f, "RESOLVE", "1"), assigned.after), resolvedBefore = JSON.stringify(resolved);
    expect(resolved.after).toMatchObject({ version: "2", status: "RESOLVED", assignedTo, resolvedBy: actorId, resolvedAt: now.toISOString() });
    const reopened = decide(f, command(f, "REOPEN", "2"), resolved.after);
    expect(reopened.after).toMatchObject({ version: "3", status: "OPEN", assignedTo, resolvedBy: null, resolvedAt: null });
    expect(JSON.stringify(f)).toBe(original); expect(JSON.stringify(assigned)).toBe(assignedBefore); expect(JSON.stringify(resolved)).toBe(resolvedBefore);
  });
  it("rejects stale version, stale native fingerprint and a different source without silent rebasing", () => {
    const f = source(), intent = command(f, "RESOLVE");
    for (const changed of [{ version: "1" }, { sourceFingerprint: "b".repeat(64) }, { source: { ...f.source, id: randomUUID() } }])
      expect(() => decide(f, { ...intent, ...changed })).toThrow(VarianceWorkflowConflictError);
  });
  it("requires eligible assignees and rejects no-op or resolved-case assignment", () => {
    const f = source(), intent = command(f, "ASSIGN"), assigned = decide(f, intent), resolved = decide(f, command(f, "RESOLVE"));
    expect(() => decide(f, intent, null, false)).toThrow(VarianceWorkflowConflictError);
    expect(() => decide(f, command(f, "ASSIGN", "1"), assigned.after)).toThrow(VarianceWorkflowConflictError);
    expect(() => decide(f, command(f, "ASSIGN", "1"), resolved.after)).toThrow(VarianceWorkflowConflictError);
    expect(() => decide(f, command(f, "REOPEN"))).toThrow(VarianceWorkflowConflictError);
    expect(() => decide(f, command(f, "RESOLVE", "1"), resolved.after)).toThrow(VarianceWorkflowConflictError);
  });
  it("reopens a changed nonzero native assessment while preserving the assignee and earlier resolution history", () => {
    const f = source(), assigned = decide(f, command(f, "ASSIGN")), resolved = decide(f, command(f, "RESOLVE", "1"), assigned.after), original = JSON.stringify(resolved);
    const current = { ...f, fingerprint: "b".repeat(64), reason: "Actual later source assessment", action: "Review the new original assessment" };
    expect(projectVarianceWorkflow(current, resolved.after, now)).toMatchObject({ version: "2", sourceFingerprint: current.fingerprint, status: "OPEN",
      assignedTo, reason: current.reason, action: current.action, resolvedBy: null, resolvedAt: null });
    expect(JSON.stringify(resolved)).toBe(original); expect(() => decide(current, command(f, "RESOLVE", "2"), resolved.after)).toThrow(VarianceWorkflowConflictError);
  });
  it("preserves an explicit unassignment when source changes instead of resurrecting a baseline assignee", () => {
    const f = { ...source(), baseline: { status: "OPEN" as const, assignedTo, resolvedBy: null, resolvedAt: null } }, intent = command(f, "ASSIGN");
    if (intent.operation !== "ASSIGN") throw new Error("Actual assignment intent required");
    const unassigned = decide(f, { ...intent, assignedTo: null }), changed = { ...f, fingerprint: "b".repeat(64) };
    expect(projectVarianceWorkflow(changed, unassigned.after, now).assignedTo).toBeNull();
  });
  it("keeps genuine native matching and unavailable sources outside manual resolution", () => {
    for (const state of ["MATCHED", "SOURCE_CHANGED"] as const) {
      const f = { ...source(), state }; expect(projectVarianceWorkflow(f, null, now).status).toBe(state);
      expect(() => decide(f, command(f, "RESOLVE"))).toThrow(VarianceWorkflowSourceError);
      expect(() => decide(f, command(f, "ASSIGN"))).toThrow(VarianceWorkflowSourceError);
    }
  });
  it("requires explicit reason and action and rejects editable money or source facts in workflow intent", () => {
    const f = source(), intent = command(f, "RESOLVE");
    for (const changed of [{ reason: " " }, { action: " " }, { expected: "500.25" }, { actual: "200.00" }, { currency: "MAD" }, { variance: "-300.25" }])
      expect(() => varianceWorkflowCommandSchema.parse({ ...intent, ...changed })).toThrow();
    expect(varianceWorkflowCommandSchema.parse({ ...intent, source: { ...intent.source, id: intent.source.id.toUpperCase() } }).source.id).toBe(intent.source.id);
  });
  it("derives exact aging from trusted timestamps and rejects invalid or future source clocks", () => {
    const f = source(); expect(projectVarianceWorkflow(f, null, now).ageMilliseconds).toBe("259200000");
    expect(() => projectVarianceWorkflow(f, null, new Date("2026-10-31"))).toThrow(VarianceWorkflowSourceError);
    expect(() => projectVarianceWorkflow({ ...f, createdAt: new Date("invalid") }, null, now)).toThrow(VarianceWorkflowSourceError);
  });
  it("retains exact event versions beyond JavaScript integer precision across 200 original histories", () => {
    fc.assert(fc.property(fc.bigInt({ min: 9_007_199_254_740_993n, max: 9_223_372_036_854_775_806n }), previous => {
      const f = source(), latest: VarianceWorkflowState = { version: previous.toString(), sourceFingerprint: f.fingerprint, status: "OPEN", assignedTo: null,
        reason: f.reason, action: f.action, resolvedBy: null, resolvedAt: null }, original = JSON.stringify(latest);
      const result = decide(f, command(f, "RESOLVE", previous.toString()), latest);
      expect(result.after.version).toBe((previous + 1n).toString()); expect(JSON.stringify(latest)).toBe(original);
    }), { numRuns: 200 });
  });
  it("rejects version exhaustion instead of wrapping or truncating persisted history", () => {
    const f = source(), latest: VarianceWorkflowState = { version: "9223372036854775807", sourceFingerprint: f.fingerprint, status: "OPEN", assignedTo: null,
      reason: f.reason, action: f.action, resolvedBy: null, resolvedAt: null };
    expect(() => decide(f, command(f, "RESOLVE", latest.version), latest)).toThrow(VarianceWorkflowConflictError);
  });
});
