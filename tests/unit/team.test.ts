import { describe, expect, it } from "vitest";
import {
  compensationSchema,
  compensationValue,
  availabilitySchema,
  intervalsOverlap,
  teamAssignmentSchema,
  performance
} from "@/modules/identity/domain/team";
import { validDocumentBytes } from "@/modules/identity/application/team-documents";
import { randomUUID } from "node:crypto";

describe("team domain invariants", () => {
  it("keeps compensation exact and validates all four assignment bases", () => {
    for (const mode of ["PER_JOB", "PER_MONTH", "PER_HOUR", "PERCENTAGE"] as const) {
      const parsed = compensationSchema.parse({
        assignmentId: randomUUID(),
        expectedVersion: 0,
        mode,
        amount: "19.99",
        currency: "MAD",
        effectiveFrom: "2027-01-01",
        reason: "Annual compensation review"
      });
      expect(compensationValue(parsed)).toEqual({ amount: "19.99", currency: "MAD" });
      expect(compensationSchema.safeParse({ ...parsed, amount: 19.99 }).success).toBe(false);
      expect(compensationSchema.safeParse({ ...parsed, amount: "-1" }).success).toBe(false);
      expect(compensationSchema.safeParse({ ...parsed, amount: "1.001" }).success).toBe(false);
      expect(compensationSchema.safeParse({ ...parsed, effectiveFrom: "2027-02-30" }).success).toBe(
        false
      );
    }
    expect(
      compensationSchema.safeParse({
        assignmentId: randomUUID(),
        expectedVersion: 0,
        mode: "PERCENTAGE",
        amount: "100.01",
        currency: "MAD",
        effectiveFrom: "2027-01-01",
        reason: "Annual review"
      }).success
    ).toBe(false);
  });
  it("uses exclusive return dates and rejects invalid calendar dates", () => {
    const a = { startsOn: "2027-01-01", endsOn: "2027-01-03" };
    expect(intervalsOverlap(a, { startsOn: "2027-01-03", endsOn: "2027-01-05" })).toBe(false);
    expect(intervalsOverlap(a, { startsOn: "2027-01-02", endsOn: "2027-01-05" })).toBe(true);
    for (const startsOn of ["2027-02-30", "2027-13-01", "2027-01-04"])
      expect(
        availabilitySchema.safeParse({
          ...a,
          startsOn,
          personId: randomUUID(),
          kind: "LEAVE",
          reason: "Family leave"
        }).success
      ).toBe(false);
  });
  it("requires a real scoped record and ordered assignment dates", () => {
    const value = {
      personId: randomUUID(),
      roleId: randomUUID(),
      scopeType: "property",
      scopeId: null,
      validFrom: "2027-01-01",
      validTo: null,
      assignedToMe: true,
      reason: "Property assignment"
    };
    expect(teamAssignmentSchema.safeParse(value).success).toBe(false);
    expect(teamAssignmentSchema.safeParse({ ...value, scopeId: randomUUID() }).success).toBe(true);
    expect(
      teamAssignmentSchema.safeParse({ ...value, scopeType: "organization", validTo: "2026-01-01" })
        .success
    ).toBe(false);
  });
  it("counts workload without treating cancelled or finished tasks as open", () => {
    const tasks = ["PLANNED", "COMPLETED", "CANCELLED", "IN_PROGRESS"].map((state) => ({
      state,
      dueDate: new Date("2027-01-01"),
      completedAt: state === "COMPLETED" ? new Date("2027-01-01") : null
    }));
    expect(performance(tasks, "2027-01-02")).toEqual({
      assigned: 4,
      completed: 1,
      open: 2,
      overdue: 2,
      onTime: 1,
      completionRate: "33.3"
    });
  });
  it("rejects executable or mismatched uploads before contacting storage", () => {
    const pdf = Buffer.from("%PDF-1.7\nprivate");
    expect(validDocumentBytes("application/pdf", pdf)).toBe(true);
    expect(validDocumentBytes("image/jpeg", pdf)).toBe(false);
    expect(validDocumentBytes("application/pdf", Buffer.from("<script>"))).toBe(false);
    expect(validDocumentBytes("image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  });
});
