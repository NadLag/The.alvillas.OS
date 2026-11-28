import { randomUUID } from "node:crypto";
import type { OutboxEvent } from "@prisma/client";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { signBytes, verifyBytes } from "@/platform/auth/secret-encryption";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { ConfigRuleRepository, type ConfigScopeCandidate } from "@/platform/config/config-rule-repository";
import { guestHubLinkDeliveryPolicyKey, guestHubLinkDeliveryPolicySchema,
  type GuestHubLinkDeliveryChannel } from "@/platform/config/guest-hub-link-delivery-policy";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { guestHubLinkMessage } from "@/platform/email/guest-hub-link-template";
import { guestLinkEmailEvent } from "@/platform/events/guest-link-email";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { whatsappPhone, whatsappUrl } from "@/platform/notifications/whatsapp";
import { GuestHubLinkDeliveryAccessError, guestHubLinkDeliveryCommandSchema, guestHubLinkDeliveryDraftSchema,
  guestHubLinkDeliveryReceiptSchema, guestHubLinkDeliveryReviewSchema } from "../domain/guest-hub-link-delivery";
import { GuestHubAccessError, GuestHubConflictError } from "../domain/guest-hub-policy";
import { readGuestHubDeliveryLink, type GuestHubDependencies } from "./guest-hub-service";
import { guestHubSettings } from "./guest-hub-source";

const purpose = "alvillas.guest-hub.link-delivery-review.v1";
const emailPayload = z.object({
  linkId: z.uuid(), actorId: z.uuid(), authority: z.unknown(), reviewFingerprint: guestHubLinkDeliveryCommandSchema.shape.reviewFingerprint,
  kind: z.literal("guest_hub.private_link"), channel: z.literal("email")
}).strict();

function linkAddress(origin: string, locale: string, token: string) {
  const base = new URL(origin);
  if (base.username || base.password || (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) {
    throw new GuestHubLinkDeliveryAccessError();
  }
  const url = new URL(`/${locale}/guest`, base);
  url.hash = token;
  return url.href;
}

function emailKey(linkId: string) {
  return `guest-hub-link-email:${linkId}`;
}

export async function guestHubLinkDeliverySettings(tx: TenantTransaction, organizationId: string, scopes: ConfigScopeCandidate[], now: Date) {
  const rule = await new ConfigRuleRepository(tx, organizationId).resolve({ key: guestHubLinkDeliveryPolicyKey, scopes, asOf: now });
  if (!rule?.createdBy || rule.lifecycle !== "ACTIVE") return null;
  return { rule, policy: guestHubLinkDeliveryPolicySchema.parse(rule.parsedValue) };
}

async function original(tx: TenantTransaction, actor: AccountActorContext, linkId: string, channel: GuestHubLinkDeliveryChannel, deps: GuestHubDependencies) {
  const { row, token, repository } = await readGuestHubDeliveryLink(actor, tx, linkId, deps);
  const source = await repository.source(row.reservationId);
  if (!source?.sourceAvailable || source.propertyId !== row.propertyId || source.guestId !== row.guestId) throw new GuestHubAccessError();
  const now = await repository.clock();
  const settings = await guestHubSettings(tx, actor.organizationId, source, now);
  const delivery = await guestHubLinkDeliverySettings(tx, actor.organizationId, settings.scopes, now);
  if (!delivery) throw new GuestHubLinkDeliveryAccessError();
  const { rule, policy } = delivery;
  if (!policy.channels.includes(channel)) throw new GuestHubLinkDeliveryAccessError();
  const contact = await repository.deliveryContact(row.reservationId, row.guestId);
  const candidate = z.email().safeParse(contact?.guestEmail);
  const destination = channel === "EMAIL" ? (candidate.success ? candidate.data : null) : whatsappPhone(contact?.guestPhone);
  if (!destination || !contact) throw new GuestHubLinkDeliveryAccessError();
  const locale = safeLocale(contact.guestPreferredLocale);
  const origin = deps.env?.APP_URL ?? process.env.APP_URL;
  if (!origin) throw new GuestHubLinkDeliveryAccessError();
  const url = linkAddress(origin, locale, token);
  const proof = Buffer.from(jsonbFingerprint({ organizationId: row.organizationId, linkId, reservationId: row.reservationId,
    guestId: row.guestId, actorId: actor.actorId, channel, destination, locale, url, policy: rule.id, version: rule.version }), "hex");
  const label = channel === "EMAIL" ? destination.slice(0, 1) + "•••" + destination.slice(destination.indexOf("@")) : "••• " + destination.slice(-4);
  return { row, now, destination, label, locale, url, proof };
}

function checkReview(proof: Buffer, reviewFingerprint: string, env?: NodeJS.ProcessEnv) {
  const [version, signature] = reviewFingerprint.split(".");
  if (!verifyBytes(proof, Buffer.from(signature, "hex"), version, purpose, env)) throw new GuestHubConflictError();
}

export async function reviewGuestHubLinkDelivery(actor: AccountActorContext, raw: unknown, deps: GuestHubDependencies) {
  const input = guestHubLinkDeliveryDraftSchema.parse(raw);
  return withTenant(deps.db, actor.organizationId, async tx => {
    const prepared = await original(tx, actor, input.linkId, input.channel, deps);
    const signed = signBytes(prepared.proof, purpose, deps.env);
    try {
      return guestHubLinkDeliveryReviewSchema.parse({ ...input, recipientLabel: prepared.label,
        reviewFingerprint: `${signed.version}.${signed.signature.toString("hex")}` });
    } finally {
      signed.signature.fill(0);
    }
  });
}

export async function admitGuestHubLinkDelivery(actor: AccountActorContext, raw: unknown, deps: GuestHubDependencies) {
  const input = guestHubLinkDeliveryCommandSchema.parse(raw);
  return withTenant(deps.db, actor.organizationId, async tx => {
    const prepared = await original(tx, actor, input.linkId, input.channel, deps);
    checkReview(prepared.proof, input.reviewFingerprint, deps.env);
    const { row, now } = prepared, outbox = new OutboxRepository(tx, actor.organizationId);
    const metadata = { linkId: row.id, reservationId: row.reservationId, channel: input.channel };
    if (input.channel === "EMAIL") {
      const prior = await outbox.byIdempotencyKey(emailKey(row.id));
      if (prior) {
        const payload = emailPayload.parse(prior.payload);
        if (prior.type !== guestLinkEmailEvent || payload.actorId !== actor.actorId || payload.linkId !== row.id) throw new GuestHubConflictError();
        checkReview(prepared.proof, payload.reviewFingerprint, deps.env);
        return guestHubLinkDeliveryReceiptSchema.parse({ channel: "EMAIL", linkId: row.id, queued: true });
      }
      await outbox.append(guestLinkEmailEvent, { linkId: row.id, actorId: actor.actorId,
        authority: captureAuthorizationCap(actor.authContext), reviewFingerprint: input.reviewFingerprint,
        kind: "guest_hub.private_link", channel: "email" }, emailKey(row.id), now);
    }
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId,
      action: input.channel === "EMAIL" ? guestLinkEmailEvent : "guest_hub.link_whatsapp_prepared",
      resourceType: "guest_hub", resourceId: row.id, propertyScopeId: row.propertyId, after: metadata,
      requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    return guestHubLinkDeliveryReceiptSchema.parse(input.channel === "EMAIL" ? { channel: "EMAIL", linkId: row.id, queued: true }
      : { channel: "WHATSAPP", linkId: row.id, draftUrl: whatsappUrl(prepared.destination, guestHubLinkMessage(prepared.locale, prepared.url).text) });
  });
}

export async function resolveGuestHubLinkEmail(tx: TenantTransaction, event: OutboxEvent, deps: GuestHubDependencies) {
  if (event.type !== guestLinkEmailEvent) throw new GuestHubLinkDeliveryAccessError();
  const payload = emailPayload.parse(event.payload);
  const authority = restoreAuthorizationCap(payload.authority);
  if (event.idempotencyKey !== emailKey(payload.linkId) || authority.organizationId !== event.organizationId || authority.userAccountId !== payload.actorId) {
    throw new GuestHubLinkDeliveryAccessError();
  }
  const actor = { organizationId: event.organizationId, actorId: payload.actorId, authContext: authority };
  const prepared = await original(tx, actor, payload.linkId, "EMAIL", deps);
  checkReview(prepared.proof, payload.reviewFingerprint, deps.env);
  return { to: prepared.destination, ...guestHubLinkMessage(prepared.locale, prepared.url) };
}
