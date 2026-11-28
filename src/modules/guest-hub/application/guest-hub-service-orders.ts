import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { signBytes, verifyBytes } from "@/platform/auth/secret-encryption";
import { catalogFieldPolicy, present } from "@/platform/authz/present";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { createServiceOrder, inspectNewServiceOrder, serviceOrderAuthority, ServiceOrderConflictError, ServiceOrderValidationError }
  from "@/platform/services/guest-order-authority";
import { bindGuestServiceOrderSelection, guestServiceOrderDraftSchema, guestServiceOrderPublicReviewSchema,
  guestServiceOrderReceiptSchema, guestServiceOrderRecoveryResponseSchema, guestServiceOrderRecoverySchema,
  guestServiceOrderSelectionSchema, guestServiceOrderSubmitSchema } from "@/platform/services/guest-service-order-contracts";
import { renderGuestHubFormNotice } from "../domain/guest-hub-form-policy";
import { GuestHubServiceOrderAccessError, GuestHubServiceOrderConflictError } from "../domain/guest-hub-service-order-policy";
import { GuestHubServiceOrderRepository } from "../infrastructure/guest-hub-service-order-repository";
import { withGuestHubForm, type GuestHubFormContext } from "./guest-hub-form-visit";
import { activeGuestHubServiceOrder } from "./guest-hub-service-order-source";
import type { GuestHubVisitDependencies } from "./guest-hub-visit";

type Context = GuestHubFormContext<Awaited<ReturnType<typeof activeGuestHubServiceOrder>>>;
type Draft = z.infer<typeof guestServiceOrderDraftSchema>;
type Receipt = NonNullable<Awaited<ReturnType<GuestHubServiceOrderRepository["receiptByNonce"]>>>;
const resourceType = "guest_hub_service_orders";
const reviewPurpose = "alvillas.guest-hub.service-order-review.v1";
const commandPurpose = "alvillas.guest-hub.service-order-command.v1";
const receiptPurpose = "alvillas.guest-hub.service-order-receipt.v1";
const reviewPrefix = "guest-service-order-review-v1";
const reviewMetadata = z.object({ version: z.string().min(1).max(120), issued: z.number().int().positive() }).strict();
const proof = (input: unknown) => Buffer.from(jsonbFingerprint(input), "hex");

function withOrders<T>(capability: unknown, deps: GuestHubVisitDependencies, work: (context: Context) => Promise<T>, submission = false) {
  return withGuestHubForm(capability, deps, {
    resourceType, rateKey: "guest-hub:service-order:", active: activeGuestHubServiceOrder,
    lock: context => new GuestHubServiceOrderRepository(context.tx, context.actual.row.organizationId).lockLink(context.actual.row.id),
    AccessError: GuestHubServiceOrderAccessError,
    isValidation: error => error instanceof GuestHubServiceOrderConflictError || error instanceof ServiceOrderConflictError || error instanceof ServiceOrderValidationError
  }, work, submission);
}

function presentOrder(context: Context, data: Record<string, unknown>) {
  return present({ ...context.formAuthority, visibleDataClasses: new Set() }, "view", { ...context.formResource, data }, catalogFieldPolicy(resourceType), context.form.now);
}

async function quote(context: Context, input: Draft) {
  const { serviceKey, serviceDate, lastServiceDate, quantity, guests, groceryItems, transfer, idempotencyKey, locale } = input;
  const selection = guestServiceOrderSelectionSchema.parse({ serviceKey, serviceDate, lastServiceDate, quantity, guests,
    ...(groceryItems ? { groceryItems } : {}), ...(transfer ? { transfer } : {}) });
  const offer = context.form.offers.find(item => item.key === serviceKey);
  if (!offer) throw new GuestHubServiceOrderAccessError();
  const request = bindGuestServiceOrderSelection(selection, context.actual.source, idempotencyKey);
  const native = await inspectNewServiceOrder(context.form.actor, context.tx, request);
  const totalAmount = native.price.kind === "PRICED" ? native.price.amount.toJSON().amount : null;
  const notice = renderGuestHubFormNotice(context.form.policy.notice, locale);
  const data = { selection, title: offer.name, totalAmount, currency: offer.currency, quoteRequired: offer.quoteRequired,
    ...(offer.chefMenu ? { chefMenu: offer.chefMenu } : {}), ...(offer.category ? { category: offer.category } : {}), notice };
  const binding = { ...data, idempotencyKey, locale, form: context.form.fingerprint, native: native.reviewFingerprint };
  return { data, binding, request, native };
}

function readReview(token: string) {
  try {
    const [prefix, encoded, signature] = token.split(".");
    if (prefix !== reviewPrefix || !encoded || !signature) throw new GuestHubServiceOrderConflictError();
    const metadata = reviewMetadata.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return { ...metadata, signature: Buffer.from(signature, "base64url") };
  } catch {
    throw new GuestHubServiceOrderConflictError();
  }
}

type ReceiptFields = Omit<Receipt, "order" | "signature" | "signatureVersion" | "totalAmount"> & {
  totalAmount: Receipt["totalAmount"] | string;
};

function receiptBinding(row: ReceiptFields) {
  const totalAmount = typeof row.totalAmount === "string" ? row.totalAmount : row.totalAmount?.toFixed(2) ?? null;
  return { id: row.id, organizationId: row.organizationId, linkId: row.linkId, grantId: row.grantId,
    orderId: row.orderId, eventId: row.eventId, commandKey: row.commandKey, commandHash: row.commandHash,
    commandKeyVersion: row.commandKeyVersion, reviewFingerprint: row.reviewFingerprint, nativeReviewFingerprint: row.nativeReviewFingerprint,
    sourceFingerprint: row.sourceFingerprint, selectionSnapshot: row.selectionSnapshot, noticeSnapshot: row.noticeSnapshot,
    totalAmount, currency: row.currency, requestedLocale: row.requestedLocale, reviewedAt: row.reviewedAt.toISOString(),
    reviewExpiresAt: row.reviewExpiresAt.toISOString(), outboxEventId: row.outboxEventId, createdAt: row.createdAt.toISOString(), requestId: row.requestId };
}

async function receipt(context: Context, row: Receipt, replayed: boolean, env?: NodeJS.ProcessEnv) {
  if (row.grantId !== context.form.grant.id || !verifyBytes(proof(receiptBinding(row)), Buffer.from(row.signature, "hex"),
    row.signatureVersion, receiptPurpose, env)) throw new GuestHubServiceOrderAccessError();
  await serviceOrderAuthority(context.form.actor, context.tx, row.order);
  return guestServiceOrderReceiptSchema.parse(presentOrder(context, { id: row.id, orderId: row.orderId, idempotencyKey: row.commandKey,
    state: row.order.state, version: row.order.version, totalAmount: row.totalAmount?.toFixed(2) ?? null,
    currency: row.currency, createdAt: row.createdAt.toISOString(), replayed }));
}

export async function reviewGuestHubServiceOrder(capability: unknown, raw: unknown, deps: GuestHubVisitDependencies) {
  const input = guestServiceOrderDraftSchema.parse(raw);
  return withOrders(capability, deps, async context => {
    const { data, binding } = await quote(context, input);
    const issued = context.form.now.getTime();
    const signed = signBytes(proof({ ...binding, issued }), reviewPurpose, deps.env);
    try {
      const metadata = Buffer.from(JSON.stringify({ version: signed.version, issued }), "utf8").toString("base64url");
      const reviewFingerprint = `${reviewPrefix}.${metadata}.${signed.signature.toString("base64url")}`;
      return guestServiceOrderPublicReviewSchema.parse(presentOrder(context, { ...data, reviewFingerprint }));
    } finally {
      signed.signature.fill(0);
    }
  });
}

export async function submitGuestHubServiceOrder(capability: unknown, raw: unknown, deps: GuestHubVisitDependencies) {
  const input = guestServiceOrderSubmitSchema.parse(raw);
  return withOrders(capability, deps, async context => {
    const { row } = context.actual, { form, tx } = context;
    const command = { organizationId: row.organizationId, linkId: row.id, grantId: form.grant.id, input };
    const original = await form.repository.receiptByNonce(row.id, input.idempotencyKey);
    if (original) {
      if (!verifyBytes(proof(command), Buffer.from(original.commandHash, "hex"), original.commandKeyVersion, commandPurpose, deps.env)) {
        throw new GuestHubServiceOrderConflictError();
      }
      return receipt(context, original, true, deps.env);
    }

    const { data, binding, request, native } = await quote(context, input);
    const review = readReview(input.reviewFingerprint);
    const expiresAt = new Date(Math.min(form.grant.expiresAt.getTime(), review.issued + form.policy.reviewLifetimeSeconds * 1000));
    if (review.issued > form.now.getTime() || expiresAt <= form.now || !verifyBytes(proof({ ...binding, issued: review.issued }),
      review.signature, review.version, reviewPurpose, deps.env)) throw new GuestHubServiceOrderConflictError();

    const requestId = deps.requestId ?? randomUUID();
    const event = await createServiceOrder(form.actor, { request, idempotencyKey: randomUUID(), reviewFingerprint: native.reviewFingerprint },
      { db: { $transaction: work => work(tx) }, requestId });
    const id = randomUUID();
    const createdAt = await context.actual.repository.clock();
    if (createdAt >= expiresAt) throw new GuestHubServiceOrderConflictError();
    const eventType = "guest_hub.service_order_requested";
    const metadata = { requestId: id, linkId: row.id, orderId: event.orderId };
    const outbox = await new OutboxRepository(tx, row.organizationId).append(eventType, metadata,
      `guest-hub-service-order:${row.id}:${input.idempotencyKey}`, createdAt);
    const signedCommand = signBytes(proof(command), commandPurpose, deps.env);
    const stored = { id, organizationId: row.organizationId, linkId: row.id, grantId: form.grant.id, orderId: event.orderId,
      eventId: event.eventId, commandKey: input.idempotencyKey, commandHash: signedCommand.signature.toString("hex"),
      commandKeyVersion: signedCommand.version, reviewFingerprint: input.reviewFingerprint, nativeReviewFingerprint: native.reviewFingerprint,
      sourceFingerprint: form.sourceFingerprint, selectionSnapshot: data.selection, noticeSnapshot: data.notice, totalAmount: data.totalAmount,
      currency: data.currency, requestedLocale: input.locale, reviewedAt: new Date(review.issued), reviewExpiresAt: expiresAt,
      outboxEventId: outbox.id, createdAt, requestId };
    signedCommand.signature.fill(0);
    const signedReceipt = signBytes(proof(receiptBinding(stored)), receiptPurpose, deps.env);
    try {
      await form.repository.appendReceipt({ ...stored, signatureVersion: signedReceipt.version, signature: signedReceipt.signature.toString("hex") });
    } finally {
      signedReceipt.signature.fill(0);
    }
    await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: eventType, resourceType,
      resourceId: id, propertyScopeId: row.propertyId, after: metadata, requestId, occurredAt: createdAt });
    await form.repository.validateReceipt();
    const recorded = await form.repository.receiptByNonce(row.id, input.idempotencyKey);
    if (!recorded) throw new GuestHubServiceOrderConflictError();
    return receipt(context, recorded, false, deps.env);
  }, true);
}

export async function recoverGuestHubServiceOrder(capability: unknown, raw: unknown, deps: GuestHubVisitDependencies) {
  const { idempotencyKey } = guestServiceOrderRecoverySchema.parse(raw);
  return withOrders(capability, deps, async context => {
    const original = await context.form.repository.receiptByNonce(context.actual.row.id, idempotencyKey);
    return guestServiceOrderRecoveryResponseSchema.parse(original
      ? { ...await receipt(context, original, true, deps.env), recorded: true }
      : { recorded: false, idempotencyKey });
  });
}
