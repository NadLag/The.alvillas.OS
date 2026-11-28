import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { guestHubLinkDeliveryPolicyKey } from "@/platform/config/guest-hub-link-delivery-policy";
import { guestLinkEmailEvent } from "@/platform/events/guest-link-email";
import { deliverEmail } from "@/platform/notifications/email-delivery-service";
import type { EmailProvider } from "@/platform/providers";
import { issueGuestHubLink, reviewGuestHubIssue, reviewGuestHubRevocation, revokeGuestHubLink } from "@/modules/guest-hub/application/guest-hub-service";
import { admitGuestHubLinkDelivery, reviewGuestHubLinkDelivery } from "@/modules/guest-hub/application/guest-hub-link-delivery";
import { readGuestHubWorkspace } from "@/modules/guest-hub/application/guest-hub-workspace";
import { GuestHubAccessError } from "@/modules/guest-hub/domain/guest-hub-policy";
import { nativeGuestHubFixture } from "./support/guest-hub-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const env: NodeJS.ProcessEnv = { NODE_ENV: "test", APP_URL: "http://localhost:3000",
  ENCRYPTION_KEYS: `owned-link-delivery:${randomBytes(32).toString("base64")}` };
let admin: PrismaClient, db: PrismaClient;

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1/undefined");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !(url.pathname === "/alvillas_guest_orders_isolated_20261128" || process.env.GITHUB_ACTIONS === "true" && url.pathname === "/alvillas_os")) {
    throw Error("Use the isolated migrated Guest Hub database for link delivery tests");
  }
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  await provisionIntegrationRole(admin, "alvillas_ops_tests");
  url.username = url.password = "alvillas_ops_tests";
  db = new PrismaClient({ datasourceUrl: url.toString() });
});

afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

it("shares only the reviewed original contact and retains a single native email delivery", async () => {
  const fixture = await nativeGuestHubFixture(admin, db);
  const foreign = await nativeGuestHubFixture(admin, db);
  const { organizationId, property, account, reservation, ctx } = fixture;
  const deps = { db, env };
  const email = "original-delivery@example.test";
  await withTenant(db, organizationId, async tx => {
    await tx.reservation.update({ where: { id: reservation.id }, data: { guestEmail: email, guestPhone: "+212612345678" } });
    await new ConfigRuleRepository(tx, organizationId).createVersion({ key: guestHubLinkDeliveryPolicyKey, scopeType: "property",
      scopeId: property.id, effectiveFrom: new Date("2020-01-01"), createdBy: account.id,
      value: { source: "ORIGINAL_RESERVATION_CONTACT", channels: ["EMAIL", "WHATSAPP"], approval_reference: "Owned synthetic delivery approval" },
      reason: "Approve synthetic delivery to the original reservation contact" });
  });
  async function issue() {
    const input = { reservationId: reservation.id };
    const review = await reviewGuestHubIssue(ctx, input, deps);
    const issued = await issueGuestHubLink(ctx, { ...input, idempotencyKey: randomUUID(),
      reviewFingerprint: review.reviewFingerprint, reason: "Issue original synthetic delivery link" }, deps);
    if (!issued.token) throw Error("The original issued capability was unavailable");
    return { ...issued, token: issued.token };
  }
  const issued = await issue();
  expect((await readGuestHubWorkspace(ctx, { reservationId: reservation.id }, deps)).items[0].deliveryChannels).toEqual(["EMAIL", "WHATSAPP"]);
  const whatsapp = await reviewGuestHubLinkDelivery(ctx, { linkId: issued.id, channel: "WHATSAPP" }, deps);
  expect(whatsapp.recipientLabel).toBe("••• 5678");
  const draft = await admitGuestHubLinkDelivery(ctx, { linkId: issued.id, channel: "WHATSAPP", reviewFingerprint: whatsapp.reviewFingerprint }, deps);
  if (draft.channel !== "WHATSAPP") throw Error("The reviewed manual draft was not available");
  const destination = new URL(draft.draftUrl);
  expect(destination.origin).toBe("https://wa.me");
  expect(destination.pathname).toBe("/212612345678");
  expect(destination.searchParams.get("text")?.includes(`http://localhost:3000/fr/guest#${issued.token}`)).toBe(true);
  await expect(reviewGuestHubLinkDelivery(foreign.ctx, { linkId: issued.id, channel: "EMAIL" }, deps)).rejects.toBeInstanceOf(GuestHubAccessError);

  async function queue(linkId: string) {
    const review = await reviewGuestHubLinkDelivery(ctx, { linkId, channel: "EMAIL" }, deps);
    expect(review.recipientLabel).toBe("o•••@example.test");
    return admitGuestHubLinkDelivery(ctx, { linkId, channel: "EMAIL", reviewFingerprint: review.reviewFingerprint }, deps);
  }
  const receipt = await queue(issued.id);
  expect(await queue(issued.id)).toEqual(receipt);
  const events = () => withTenant(db, organizationId, tx => tx.outboxEvent.findMany({ where: { organizationId, type: guestLinkEmailEvent }, orderBy: { occurredAt: "asc" } }));
  const pending = await events();
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(pending[0].payload).includes(issued.token)).toBe(false);
  expect(JSON.stringify(pending[0].payload).includes(email)).toBe(false);
  const sent: Parameters<EmailProvider["send"]>[0][] = [];
  const provider: EmailProvider = { send: message => { sent.push(message); return Promise.resolve({ id: "owned-guest-delivery" }); } };
  await deliverEmail(pending[0], { ...deps, provider });
  await deliverEmail(pending[0], { ...deps, provider });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(email);
  expect(sent[0].locale).toBe("fr");
  expect(sent[0].text?.includes(issued.token)).toBe(true);

  const withdrawn = await issue();
  await queue(withdrawn.id);
  const revocation = { linkId: withdrawn.id };
  const reviewed = await reviewGuestHubRevocation(ctx, revocation, deps);
  await revokeGuestHubLink(ctx, { ...revocation, idempotencyKey: randomUUID(), reviewFingerprint: reviewed.reviewFingerprint,
    reason: "Withdraw the original link before the queued delivery" }, deps);
  const second = (await events()).at(-1);
  if (!second || second.id === pending[0].id) throw Error("The later delivery event was unavailable");
  await deliverEmail(second, { ...deps, provider });
  expect(sent).toHaveLength(1);
  expect(await withTenant(db, organizationId, tx => tx.notificationDelivery.findFirstOrThrow({ where: { organizationId, eventId: second.id } })))
    .toMatchObject({ status: "SUPPRESSED", errorCode: "preferences_or_access_changed" });
});
