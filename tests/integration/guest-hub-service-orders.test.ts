import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { visitGuestHubLink } from "@/modules/guest-hub/application/guest-hub-visit";
import { listGuestHubServiceOffers } from "@/modules/guest-hub/application/guest-hub-service-order-offers";
import { recoverGuestHubServiceOrder, reviewGuestHubServiceOrder, submitGuestHubServiceOrder } from "@/modules/guest-hub/application/guest-hub-service-orders";
import { GuestHubInvalidLinkError } from "@/modules/guest-hub/domain/guest-hub-policy";
import { GuestHubServiceOrderConflictError } from "@/modules/guest-hub/domain/guest-hub-service-order-policy";
import { nativeGuestServiceOrderFixture } from "./support/guest-service-order-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ENCRYPTION_KEYS: `owned-guest-service:${randomBytes(32).toString("base64")}` };
let admin: PrismaClient, db: PrismaClient;

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1/undefined");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !(url.pathname === "/alvillas_guest_orders_isolated_20261128" || process.env.GITHUB_ACTIONS === "true" && url.pathname === "/alvillas_os")) {
    throw new Error("Use an isolated migrated PostgreSQL guest-order database");
  }
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  expect((await admin.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('public.guest_hub_service_order_request') IS NOT NULL AS present`)[0].present).toBe(true);
  await provisionIntegrationRole(admin, "alvillas_ops_tests");
  url.username = url.password = "alvillas_ops_tests";
  db = new PrismaClient({ datasourceUrl: url.toString() });
});

afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

it("releases a private native catalog offer, accepts one exact request and withdraws guest access, preserving journals", async () => {
  const { fixture, deps, capability, issued, decide } = await nativeGuestServiceOrderFixture(admin, db, env);
  expect((await visitGuestHubLink(capability, deps)).home.serviceOrdersAvailable).toBeUndefined();
  await expect(listGuestHubServiceOffers(capability, {}, deps)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);
  await decide("GRANTED");
  expect((await visitGuestHubLink(capability, deps)).home.serviceOrdersAvailable).toBe(true);
  const offers = await listGuestHubServiceOffers(capability, {}, deps);
  expect(offers.items).toHaveLength(1);
  expect(offers.items[0]).toMatchObject({ key: fixture.entry.key, unitAmount: "120.00", currency: "MAD" });
  expect(JSON.stringify(offers)).not.toContain(fixture.supplierName);
  expect(JSON.stringify(offers)).not.toContain("30.00");
  await expect(listGuestHubServiceOffers(capability, {}, { ...deps, expectedLinkId: randomUUID() })).rejects.toBeInstanceOf(GuestHubInvalidLinkError);

  const draft = { serviceKey: fixture.request.serviceKey, serviceDate: fixture.request.serviceDate, lastServiceDate: fixture.request.lastServiceDate,
    quantity: 2, guests: 1, locale: "fr", idempotencyKey: randomUUID() };
  const financial = () => withTenant(db, fixture.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(t) AS row FROM financial_transaction t ORDER BY id`);
  const before = await financial();
  const quote = await reviewGuestHubServiceOrder(capability, draft, deps);
  expect(quote).toMatchObject({ totalAmount: "240.00", currency: "MAD", quoteRequired: false, notice: { title: "Informations sur le service" } });
  const command = { ...draft, acknowledged: true, reviewFingerprint: quote.reviewFingerprint };
  const first = await submitGuestHubServiceOrder(capability, command, deps);
  expect(first).toMatchObject({ state: "REQUESTED", totalAmount: "240.00", replayed: false });
  await expect(submitGuestHubServiceOrder(capability, command, deps)).resolves.toMatchObject({ orderId: first.orderId, replayed: true });
  await expect(submitGuestHubServiceOrder(capability, { ...command, quantity: 3 }, deps)).rejects.toBeInstanceOf(GuestHubServiceOrderConflictError);
  await expect(recoverGuestHubServiceOrder(capability, { idempotencyKey: draft.idempotencyKey }, deps)).resolves.toMatchObject({ recorded: true, orderId: first.orderId });
  await withTenant(db, fixture.organizationId, async tx => {
    expect(await tx.serviceOrder.count({ where: { reservationId: fixture.reservation.id } })).toBe(1);
    expect(await tx.guestHubServiceOrderRequest.count({ where: { linkId: issued.id } })).toBe(1);
    expect(await tx.auditLog.count({ where: { action: "guest_hub.service_order_requested", resourceId: first.id, actorId: null } })).toBe(1);
  });
  expect(await financial()).toEqual(before);
  await decide("WITHDRAWN");
  await expect(recoverGuestHubServiceOrder(capability, { idempotencyKey: draft.idempotencyKey }, deps)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);
  expect((await visitGuestHubLink(capability, deps)).home.serviceOrdersAvailable).toBeUndefined();
});
