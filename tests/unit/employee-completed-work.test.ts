import { describe, expect, it } from "vitest";
import { employeeCompletedWorkEvidence } from "@/modules/finance/domain/employee-completed-work";

const org = "00000000-0000-4000-8000-000000000001", task = "00000000-0000-4000-8000-000000000002";
const performer = "00000000-0000-4000-8000-000000000003", performerAccount = "00000000-0000-4000-8000-000000000004";
const validator = "00000000-0000-4000-8000-000000000005", validatorAccount = "00000000-0000-4000-8000-000000000006";
function source(method: "SELF" | "OFFLINE_SYNC" | "PROXY" = "SELF") {
  return { id: task, organizationId: org, taskId: task, version: 4, actorId: method === "PROXY" ? validatorAccount : performerAccount, after: {
    id: task, organization_id: org, property_id: org, version: 4, state: "COMPLETED", completed_at: "2026-10-30T02:00:00.123+00:00",
    completed_by_person_id: performer, completed_by_user_account_id: method === "PROXY" ? null : performerAccount,
    completion_idempotency_key: task, completion_source: method, required_role_key: "contracted_pool_work",
    validated_by_person_id: method === "PROXY" ? validator : null, validated_by_user_account_id: method === "PROXY" ? validatorAccount : null,
    validated_at: method === "PROXY" ? "2026-10-30T02:00:00.123+00:00" : null, validation_reason: method === "PROXY" ? "No internet at the property" : null
  } };
}
describe("immutable employee completed-work evidence", () => {
  it.each(["SELF", "OFFLINE_SYNC", "PROXY"] as const)("preserves the actual performer for %s completion", method => {
    const result = employeeCompletedWorkEvidence(source(method));
    expect(result.completed_by_person_id).toBe(performer);
    expect(result.completion_source).toBe(method);
    if (method === "PROXY") expect(result.validated_by_person_id).toBe(validator);
  });
  it.each(["organizationId", "taskId", "actorId"] as const)("rejects a mismatched %s", field => {
    expect(() => employeeCompletedWorkEvidence({ ...source(), [field]: validator })).toThrow();
  });
  it("rejects a different event version and missing actor", () => {
    expect(() => employeeCompletedWorkEvidence({ ...source(), version: 5 })).toThrow();
    expect(() => employeeCompletedWorkEvidence({ ...source(), actorId: null })).toThrow();
  });
  it.each([
    { completed_by_person_id: null }, { completed_by_user_account_id: validatorAccount }, { state: "PLANNED" }, { completion_source: "UNVERIFIED" }
  ])("rejects incomplete or unattributed direct evidence %#", patch => {
    const event = source(); expect(() => employeeCompletedWorkEvidence({ ...event, after: { ...event.after, ...patch } })).toThrow();
  });
  it.each([
    { validated_by_person_id: performer }, { validated_by_user_account_id: performerAccount }, { validated_by_person_id: null },
    { validated_at: null }, { validation_reason: "    " }
  ])("rejects incomplete or self-attributed proxy evidence %#", patch => {
    const event = source("PROXY"); expect(() => employeeCompletedWorkEvidence({ ...event, after: { ...event.after, ...patch } })).toThrow();
  });
});
