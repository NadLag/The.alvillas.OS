import { describe, expect, it } from "vitest";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  ReservationAuthorizationError,
  completeAssignedFieldTask,
  createManualReservation,
  listOperationTasks,
  listReservations,
  parseManualReservationInput
} from "@/modules/reservations/application/reservation-service";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
import type { TenantTransactionRunner } from "@/platform/db/tenant";

const deniedDb: TenantTransactionRunner = {
  $transaction() {
    return Promise.reject(new Error("database should not be reached for denied reservation access"));
  }
};

function actor(authContext: AuthContext): ReservationActorContext {
  return {
    organizationId: authContext.organizationId,
    actorId: "018f0a0b-0000-7000-9000-000000000711",
    personId: "018f0a0b-0000-7000-9000-000000000712",
    authContext
  };
}

describe("reservation service authorization and validation", () => {
  it("denies reservation reads before reaching the repository", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set(),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(listReservations(ctx, { db: deniedDb })).rejects.toBeInstanceOf(
      ReservationAuthorizationError
    );
  });

  it("denies task reads before reaching the repository", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([permissionKey("reservation", "view")]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(listOperationTasks(ctx, { db: deniedDb })).rejects.toBeInstanceOf(
      ReservationAuthorizationError
    );
  });

  it("denies manual reservation creation unless both reservation and task creation are allowed", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([permissionKey("reservation", "create")]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });
    const parsed = parseManualReservationInput({
      propertyId: "018f0a0b-0000-7000-9000-000000000101",
      guestName: "Denied Guest",
      source: "MANUAL",
      checkIn: "2027-03-10",
      checkOut: "2027-03-14",
      adultCount: 2,
      childCount: 0,
      idempotencyKey: "018f0a0b-0000-7000-9000-000000000201"
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    await expect(createManualReservation(ctx, parsed.data, { db: deniedDb })).rejects.toBeInstanceOf(
      ReservationAuthorizationError
    );
  });

  it("denies assigned task completion before reaching the repository", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([permissionKey("task", "view")]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(
      completeAssignedFieldTask(
        ctx,
        {
          taskId: "018f0a0b-0000-7000-9000-000000000501",
          checklistItemIds: ["018f0a0b-0000-7000-9000-000000000601"]
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
  });

  it("validates that check-out is after check-in", () => {
    const parsed = parseManualReservationInput({
      propertyId: "018f0a0b-0000-7000-9000-000000000101",
      guestName: "Invalid Dates",
      source: "MANUAL",
      checkIn: "2027-03-14",
      checkOut: "2027-03-14",
      adultCount: 2,
      childCount: 0,
      idempotencyKey: "018f0a0b-0000-7000-9000-000000000202"
    });

    expect(parsed.success).toBe(false);
  });
});
