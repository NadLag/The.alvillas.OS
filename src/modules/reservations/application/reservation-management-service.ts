import { propertyMinute } from "../domain/operation-task";
import type { Prisma } from "@prisma/client";
import { OperationRepository } from "../infrastructure/operation-repository";
import { assignTaskInTransaction,taskCandidates } from "./operation-scheduling";
import { taskResource } from "./operation-service";
import { connectPropertyReservationChannel, recordPropertyReservationSync } from "@/platform/reservations/property-channel";
import { decryptSecret } from "@/platform/auth/secret-encryption";
import { createHash, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import type { ReservationActorContext } from "./reservation-access";
import { createManualReservationInTransaction, ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError, type ReservationAuditMeta } from "./reservation-service";
import { captureConfirmation } from "./reservation-history";
import { ReservationRepository, externalKey, normalizedHash } from "../infrastructure/reservation-repository";
import { fetchIcalFeed, feedUrl, type FeedTransport } from "../infrastructure/ical-transport";
import { AirbnbAdapter, BookingComAdapter, CSVAdapter, ICalAdapter, VrboAdapter } from "../domain/adapters";
import { blockInputSchema, calendarQuerySchema, reservationStates, canTransition, changeReservationSchema, feedInputSchema, localDate, reservationImportSchema, sameGuest, terminalStates, type NormalizedReservation } from "../domain/reservation";
import { dateToUtc, nightsBetween } from "../domain/reservation-task";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, authorizeCollection, type Action } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { authContextForAccount } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { reverseReservationAccommodationRevenue } from "@/platform/reservations/finance";
import { logger } from "@/platform/observability/logger";
import { captureException } from "@/platform/observability/sentry";

type Deps = { db?: TenantTransactionRunner; requestId?: string; ipAddress?: string | null; now?: Date; transport?: FeedTransport; guestSearch?: string };
const database = (deps: Deps) => deps.db ?? prisma;
async function meta(deps: Deps): Promise<ReservationAuditMeta> {
  if (deps.requestId) return { requestId: deps.requestId, ipAddress: deps.ipAddress ?? null };
  const values = await headers();
  return { requestId: values.get("x-request-id") ?? randomUUID(), ipAddress: values.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null };
}
function allowed(ctx: ReservationActorContext, action: Action, propertyId?: string, reservationId?: string, status?: string, location?: { city: string; cityId?: string | null; region?: string | null; regionId?: string | null }) {
  if (ctx.organizationId !== ctx.authContext.organizationId || !(propertyId ? authorize(ctx.authContext, action, { type: "reservation", organizationId: ctx.organizationId, propertyId, reservationId, id: reservationId, status, city: location?.cityId ?? location?.city, region: location?.regionId ?? location?.region }) : authorizeCollection(ctx.authContext, action, "reservation"))) throw new ReservationAuthorizationError();
}
function financialAllowed(ctx: ReservationActorContext, action: Action, propertyId: string, reservationId?: string, location?: { city: string; cityId?: string | null; region?: string | null; regionId?: string | null }) {
  if (!authorize(ctx.authContext, action, { type: "financial_transaction", organizationId: ctx.organizationId, propertyId, reservationId, city: location?.cityId ?? location?.city, region: location?.regionId ?? location?.region, dataClass: "financial" })) throw new ReservationAuthorizationError();
}
function audit(tx: TenantTransaction, ctx: ReservationActorContext, metadata: ReservationAuditMeta, action: string, propertyId: string, resourceId: string, before: unknown, after: unknown, reason: string) {
  return writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action, resourceType: action.startsWith("task.") ? "task" : "reservation", resourceId, propertyScopeId: propertyId, before, after, reason, ...metadata, occurredAt: new Date() });
}
type PropertyLocation = { id: string; city: string; cityId: string | null; region: string | null; regionId: string | null };
function visibleStates(ctx: ReservationActorContext, property: PropertyLocation) {
  return reservationStates.filter(status => authorize(ctx.authContext, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region, status }));
}
async function visibilityForContext(tx: TenantTransaction, ctx: ReservationActorContext) {
  const repository = new ReservationRepository(tx, ctx.organizationId), options = await repository.listPropertyOptions();
  const assignments = ctx.authContext.assignments?.length ? ctx.authContext.assignments.map(assignment => assignment.scope) : ctx.authContext.scopes;
  const ids = assignments.filter(scope => (scope.scopeType ?? scope.resourceType) === "reservation").map(scope => scope.scopeId ?? scope.resourceId).filter((id): id is string => Boolean(id && z.uuid().safeParse(id).success));
  const specific = ids.length ? (await repository.scopedReservations(ids)).filter(row => authorize(ctx.authContext, "view", { type: "reservation", organizationId: ctx.organizationId, id: row.id, reservationId: row.id, propertyId: row.propertyId, status: row.status, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region })) : [];
  const specificProperties = new Set(specific.map(row => row.propertyId));
  const groups = new Map<string, { propertyIds: string[]; statuses: string[] }>();
  const properties = options.filter(property => {
    const statuses = visibleStates(ctx, property);
    if (statuses.length) { const key = statuses.join(":"); const group = groups.get(key) ?? { propertyIds: [], statuses }; group.propertyIds.push(property.id); groups.set(key, group); }
    return statuses.length || specificProperties.has(property.id);
  });
  const where: Prisma.ReservationWhereInput = { OR: [...groups.values()].map(group => ({ propertyId: { in: group.propertyIds }, status: { in: group.statuses } })) };
  if (specific.length) (where.OR as Prisma.ReservationWhereInput[]).push({ id: { in: specific.map(row => row.id) } });
  return { properties, where, widePropertyIds: [...groups.values()].flatMap(group => group.propertyIds) };
}

export async function connectReservationFeed(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "configure");
  const parsed = feedInputSchema.parse(input); feedUrl(parsed.url);
  const metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    const property = await repository.property(parsed.propertyId);
    if (!property) throw new ReservationNotFoundError();
    allowed(ctx, "configure", property.id, undefined, undefined, property);
    await repository.feedPolicy(property.id, deps.now ?? new Date());
    if (!authorize(ctx.authContext, "edit", { type: "property", organizationId: ctx.organizationId, propertyId: property.id, id: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region })) throw new ReservationAuthorizationError();
    const channel = await connectPropertyReservationChannel(tx, ctx, parsed, metadata);
    const feed = await repository.createFeed({ propertyId: parsed.propertyId, source: parsed.source, name: parsed.name, bookingChannelId: channel.id, idempotencyKey: parsed.idempotencyKey }, ctx.actorId);
    await audit(tx, ctx, metadata, "reservation.feed.connected", property.id, feed.id, null, { feedId: feed.id, source: feed.source, name: feed.name }, "Connect calendar feed");
    return { id: feed.id };
  });
}

async function appendChange(tx: TenantTransaction, ctx: ReservationActorContext, input: z.infer<typeof changeReservationSchema>, metadata: ReservationAuditMeta, fromFeed = false) {
  const repository = new ReservationRepository(tx, ctx.organizationId);
  const original = await repository.reservation(input.reservationId);
  if (!original) throw new ReservationNotFoundError();
  allowed(ctx, "edit", original.propertyId, original.id, original.status, original.property);
  await repository.lockProperty(original.propertyId);
  const before = (await repository.reservation(original.id))!;
  const replay = await repository.revision(input.idempotencyKey);
  if (replay) {
    if (replay.reservationId !== before.id) throw new ReservationConflictError();
    if (replay.operation === "REFUND" || input.operation === "REFUND") {
      if (replay.operation !== input.operation || replay.createdBy !== ctx.actorId || replay.reason !== input.reason ||
        replay.version !== input.expectedVersion + 1) throw new ReservationConflictError();
      financialAllowed(ctx, "void", before.propertyId, before.id, before.property);
      await reverseReservationAccommodationRevenue(ctx, { reservationId: before.id, reason: input.reason, idempotencyKey: input.idempotencyKey },
        { db: { $transaction: work => work(tx) }, ...metadata });
    }
    return before;
  }
  if (before.version !== input.expectedVersion) throw new ReservationConflictError("reservation_version_changed");
  if (input.quote) financialAllowed(ctx, "create", before.propertyId, before.id, before.property);
  if (input.operation === "REFUND") {
    financialAllowed(ctx, "void", before.propertyId, before.id, before.property);
    await reverseReservationAccommodationRevenue(ctx, { reservationId: before.id, reason: input.reason, idempotencyKey: input.idempotencyKey }, { db: { $transaction: work => work(tx) }, ...metadata });
  }
  let status = before.status;
  if (input.operation === "TRANSITION") {
    if (!input.status || !canTransition(before.status, input.status)) throw new ReservationConflictError("invalid_reservation_transition");
    status = input.status;
  }
  if (input.operation === "EARLY_CHECKOUT") {
    if (!["CHECKED_IN", "STAYING"].includes(before.status) || !input.checkOut || input.checkOut >= before.checkOut.toISOString().slice(0, 10) || input.checkOut > localDate(new Date(), before.property.timezone)) throw new ReservationConflictError("invalid_early_checkout");
    status = "CHECKED_OUT";
  }
  if (terminalStates.includes(before.status) && input.operation !== "REFUND") throw new ReservationConflictError("terminal_reservation");
  if (input.operation === "MODIFY" && ["CHECKED_OUT", "FINANCIAL_RECONCILIATION"].includes(before.status)) throw new ReservationConflictError("completed_stay");
  const checkIn = input.checkIn ?? before.checkIn.toISOString().slice(0, 10), checkOut = input.checkOut ?? before.checkOut.toISOString().slice(0, 10);
  if (checkOut <= checkIn) throw new ReservationConflictError("invalid_stay_dates");
  if (["CHECKED_IN", "STAYING"].includes(before.status) && checkIn !== before.checkIn.toISOString().slice(0, 10)) throw new ReservationConflictError("arrival_already_recorded");
  if (input.guestName || input.guestEmail) {
    if (!authorize(ctx.authContext, "edit", { type: "guest", organizationId: ctx.organizationId, propertyId: before.propertyId, reservationId: before.id, city: before.property.cityId ?? before.property.city, region: before.property.regionId ?? before.property.region })) throw new ReservationAuthorizationError();
  }
  if (status === "CLOSED" && await repository.hasFinancialExceptions(before.id)) throw new ReservationConflictError("financial_reconciliation_pending");
  const after = await repository.updateReservation(before.id, {
    version: { increment: 1 }, status, checkIn: dateToUtc(checkIn), checkOut: dateToUtc(checkOut), nights: nightsBetween(checkIn, checkOut),
    ...(input.guestName ? { guestName: input.guestName } : {}), ...(input.guestEmail ? { guestEmail: input.guestEmail.toLowerCase() } : {}),
    ...(status === "CONFIRMED" && !before.confirmedAt ? { confirmedAt: new Date() } : {}),
    ...(status === "CANCELLED" ? { cancellationSuspectedAt: null } : {})
  });
  if (input.guestName || input.guestEmail) {
    const guest = await repository.guest({ guestName: after.guestName || null, guestEmail: after.guestEmail, guestPhone: after.guestPhone }, ctx.actorId);
    await repository.attachGuest(after.id, guest.id);
  }
  const snapshot = await repository.latestFinancialSnapshot(before.id);
  if ((!snapshot || before.status === "IMPORTED") && status === "CONFIRMED") await captureConfirmation(tx, ctx, before.id, input.quote ?? (snapshot?.amount && snapshot.currency ? { amount: snapshot.amount.toString(), currency: snapshot.currency } : null), after.version);
  else if (snapshot && (input.quote || checkIn !== before.checkIn.toISOString().slice(0, 10) || checkOut !== before.checkOut.toISOString().slice(0, 10) || status !== before.status || input.operation === "REFUND")) {
    await repository.financialSnapshot(before.id, after.version, input.quote ?? (snapshot.amount !== null && snapshot.currency ? { amount: snapshot.amount.toString(), currency: snapshot.currency } : null), snapshot.rules, ctx.actorId);
  }
  if (status !== "IMPORTED") {
    if (before.status === "IMPORTED" && status === "CONFIRMED") {
      if (!authorize(ctx.authContext, "create", { type: "task", organizationId: ctx.organizationId, propertyId: before.propertyId })) throw new ReservationAuthorizationError();
      const generated = await repository.generateConfirmationTasks(before.id, ctx.actorId, ctx.personId);
      for (const created of generated) {
        const operations = new OperationRepository(tx, ctx.organizationId), full = (await operations.task(created.id))!;
        if (authorize(ctx.authContext, "assign", taskResource(full))) {
          const policy = await operations.policy(full.propertyId);
          await assignTaskInTransaction(operations, ctx, full, null, policy.types[full.type]?.start_minute??policy.shift_start_minute, metadata, "Configured reservation task assignment");
        }
      }
      for (const task of generated) await audit(tx, ctx, metadata, "task.create", before.propertyId, task.id, null, task, "Confirmed imported reservation");
    }
    await new OperationRepository(tx, ctx.organizationId).lock('crew-schedule');
    const taskChanges = await repository.reconcileTasks(before.id, ctx.actorId, input.reason);
    for(const change of taskChanges){
      const operations=new OperationRepository(tx,ctx.organizationId),task=await operations.task(change.id);if(!task||['COMPLETED','CANCELLED','SKIPPED'].includes(task.state))continue;
      const resource=taskResource(task);if(!authorize(ctx.authContext,'edit',resource))throw new ReservationAuthorizationError();
      await operations.lock('crew-schedule');const policy=await operations.policy(task.propertyId),minute=task.scheduledStart?propertyMinute(task.scheduledStart,task.property.timezone):policy.types[task.type]?.start_minute??policy.shift_start_minute;
      const candidates=await taskCandidates(operations,task,task.dueDate.toISOString().slice(0,10),minute),same=task.assignedToPersonId?candidates.people.find(p=>p.personId===task.assignedToPersonId&&!p.conflict):null;
      if(authorize(ctx.authContext,'assign',resource))await assignTaskInTransaction(operations,ctx,task,same?.personId??null,minute,metadata,input.reason);
      else {await operations.context(ctx.actorId,metadata.requestId,input.reason);await operations.update(task.id,{scheduledStart:candidates.start,scheduledEnd:candidates.end,...(task.assignedToPersonId&&!same?{state:'BLOCKED'}:{})});}
    }
    for (const change of taskChanges) await audit(tx, ctx, metadata, "task.reservation_adjusted", before.propertyId, change.id, change.before, change.after, change.reason);
    if (["CANCELLED", "NO_SHOW"].includes(status) || input.quote || input.operation === "EARLY_CHECKOUT") await repository.exception(before.propertyId, before.id, "FINANCIAL_REVIEW", `financial-change:${before.id}:${after.version}`, { operation: input.operation, version: after.version, sourceOnly: fromFeed }, ctx.actorId);
  }
  await repository.appendRevision({ reservationId: before.id, version: after.version, operation: input.operation, before, after, reason: input.reason, idempotencyKey: input.idempotencyKey, actorId: ctx.actorId });
  await audit(tx, ctx, metadata, `reservation.${input.operation.toLowerCase()}`, before.propertyId, before.id, before, after, input.reason);
  await repository.queueChange(after.id, after.version, input.operation);
  if (status === "CANCELLED") await repository.releaseMissingForReservation(after.id, ctx.actorId, input.reason);
  await repository.refreshConflicts(before.propertyId, ctx.actorId);
  return after;
}

export async function changeReservation(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "edit");
  const parsed = changeReservationSchema.parse(input), metadata = await meta(deps);
  if (parsed.operation === "REFUND") {
    parsed.idempotencyKey = z.uuid().parse(parsed.idempotencyKey).toLowerCase();
    parsed.reservationId = parsed.reservationId.toLowerCase();
  }
  return withTenant(database(deps), ctx.organizationId, tx => appendChange(tx, ctx, parsed, metadata));
}

async function ingestEntry(tx: TenantTransaction, ctx: ReservationActorContext, propertyId: string, entry: NormalizedReservation, idempotencyKey: string, metadata: ReservationAuditMeta, boundReservationId?: string | null) {
  const repository = new ReservationRepository(tx, ctx.organizationId);
  const property = await repository.property(propertyId);
  if (!property) throw new ReservationNotFoundError();
  allowed(ctx, "create", propertyId, undefined, undefined, property);
  if (entry.quote) financialAllowed(ctx, "create", propertyId, undefined, property);
  if (entry.kind === "block") {
    const existing = await repository.sourceBlock(propertyId, entry);
    if (existing) {
      const status = entry.cancelled ? "CANCELLED" : "ACTIVE";
      const modified = existing.checkIn.toISOString().slice(0, 10) !== entry.checkIn || existing.checkOut.toISOString().slice(0, 10) !== entry.checkOut || existing.status !== status;
      if (modified) {
        const after = await repository.updateBlock(existing.id, { checkIn: dateToUtc(entry.checkIn), checkOut: dateToUtc(entry.checkOut), status });
        await audit(tx, ctx, metadata, "reservation.block.modified", propertyId, existing.id, existing, after, "Availability source changed");
      }
      return { reservationId: null, blockId: existing.id, created: false, modified, duplicate: !modified };
    }
    const block = await repository.createBlock({ propertyId, kind: "OTA", source: entry.source, externalId: entry.externalId, checkIn: entry.checkIn, checkOut: entry.checkOut, idempotencyKey }, ctx.actorId);
    if (entry.cancelled) await repository.updateBlock(block.id, { status: "CANCELLED" });
    await audit(tx, ctx, metadata, "reservation.block.imported", propertyId, block.id, null, { blockId: block.id, source: entry.source, checkIn: entry.checkIn, checkOut: entry.checkOut }, "Import availability block");
    return { reservationId: null, blockId: block.id, created: true, modified: false, duplicate: false };
  }
  const before = boundReservationId ? await repository.reservation(boundReservationId) : await repository.sourceMatch(propertyId, entry);
  if (before) {
    if (before.propertyId !== propertyId || before.source !== entry.source) throw new ReservationConflictError();
    const datesChanged = before.checkIn.toISOString().slice(0, 10) !== entry.checkIn || before.checkOut.toISOString().slice(0, 10) !== entry.checkOut;
    const guestChanged = Boolean(entry.guestName && entry.guestName !== before.guestName) || Boolean(entry.guestEmail && entry.guestEmail.toLowerCase() !== before.guestEmail);
    const confirmImported = before.status === "IMPORTED" && entry.initialState === "CONFIRMED";
    const snapshot = entry.quote ? await repository.latestFinancialSnapshot(before.id) : null;
    const quoteChanged = Boolean(entry.quote && (!snapshot?.amount || snapshot.currency !== entry.quote.currency || !snapshot.amount.eq(entry.quote.amount)));
    if (terminalStates.includes(before.status)) {
      if (!entry.cancelled || datesChanged) await repository.exception(propertyId, before.id, "SOURCE_REOPEN_REVIEW", `source-reopen:${before.id}`, { source: entry.source }, ctx.actorId);
      return { reservationId: before.id, blockId: null, created: false, modified: false, duplicate: true };
    }
    if (datesChanged || guestChanged || quoteChanged || entry.cancelled || confirmImported) {
      // Explicit source cancellations still preserve posted finances for review.
      const change = changeReservationSchema.parse({ reservationId: before.id, expectedVersion: before.version, idempotencyKey, reason: "Reservation source changed", operation: entry.cancelled || confirmImported ? "TRANSITION" : "MODIFY", ...(entry.cancelled ? { status: "CANCELLED" } : confirmImported ? { status: "CONFIRMED" } : {}),
        checkIn: entry.checkIn, checkOut: entry.checkOut, ...(entry.guestName ? { guestName: entry.guestName } : {}), ...(entry.guestEmail ? { guestEmail: entry.guestEmail } : {}), ...(quoteChanged ? { quote: entry.quote } : {}) });
      if (entry.cancelled && !canTransition(before.status, "CANCELLED")) {
        await repository.exception(propertyId, before.id, "CANCELLATION_REVIEW", `source-cancel:${before.id}`, { status: before.status }, ctx.actorId);
        return { reservationId: before.id, blockId: null, created: false, modified: false, duplicate: false };
      }
      await appendChange(tx, ctx, change, metadata, true);
      return { reservationId: before.id, blockId: null, created: false, modified: true, duplicate: false };
    }
    return { reservationId: before.id, blockId: null, created: false, modified: false, duplicate: true };
  }
  if (entry.cancelled) return { reservationId: null, blockId: null, created: false, modified: false, duplicate: true };
  const candidates = await repository.duplicateCandidates(propertyId, entry);
  for (const candidate of candidates) if (sameGuest(candidate.guestName, entry.guestName) || (entry.guestEmail && candidate.guestEmail === entry.guestEmail.toLowerCase())) await repository.exception(propertyId, candidate.id, "POSSIBLE_DUPLICATE", `duplicate:${candidate.id}:${entry.source}:${externalKey(entry)}`, { source: entry.source, externalId: entry.externalId }, ctx.actorId);
  const created = await createManualReservationInTransaction(ctx, { propertyId, source: entry.source, externalId: entry.externalId ?? undefined, guestName: entry.guestName ?? "", guestEmail: entry.guestEmail?.toLowerCase() ?? undefined, guestPhone: entry.guestPhone ?? undefined,
    quote: entry.quote ?? undefined, checkIn: entry.checkIn, checkOut: entry.checkOut, adultCount: entry.adultCount ?? 0, childCount: entry.childCount ?? 0, idempotencyKey }, tx, metadata, entry.initialState);

  return { reservationId: created.reservation.id, blockId: null, created: true, modified: false, duplicate: false };
}

export async function importReservationCsv(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "create");
  const parsed = reservationImportSchema.parse(input), metadata = await meta(deps);
  const adapter = parsed.source === "AIRBNB" ? new AirbnbAdapter() : parsed.source === "BOOKING" ? new BookingComAdapter() : parsed.source === "VRBO" ? new VrboAdapter() : new CSVAdapter();
  const entries = adapter.normalize({ content: parsed.csv, source: parsed.source, timezone: "Africa/Casablanca", dateFormat: parsed.dateFormat });
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    const property = await repository.property(parsed.propertyId);
    if (!property) throw new ReservationNotFoundError();
    allowed(ctx, "create", parsed.propertyId, undefined, undefined, property);
    await repository.lockProperty(parsed.propertyId);
    const previous = await repository.batch(parsed.propertyId, parsed.source, hash, parsed.idempotencyKey);
    if (previous) {
      if (previous.propertyId !== parsed.propertyId || previous.source !== parsed.source || previous.contentHash !== hash) throw new ReservationConflictError();
      return { ...previous, imported: 0, modified: 0, duplicates: entries.length };
    }
    const counts = { imported: 0, modified: 0, duplicates: 0 };
    for (let i = 0; i < entries.length; i++) {
      const result = await ingestEntry(tx, ctx, parsed.propertyId, entries[i], `csv:${hash}:${i}:${parsed.propertyId}`, metadata);
      counts.imported += Number(result.created); counts.modified += Number(result.modified); counts.duplicates += Number(result.duplicate);
    }
    await repository.refreshConflicts(parsed.propertyId, ctx.actorId);
    const batch = await repository.createBatch({ propertyId: parsed.propertyId, source: parsed.source, contentHash: hash, idempotencyKey: parsed.idempotencyKey, ...counts }, ctx.actorId);
    await audit(tx, ctx, metadata, "reservation.csv.imported", parsed.propertyId, batch.id, null, { batchId: batch.id, ...counts }, "Import reservation CSV");
    return batch;
  }, { timeout: 120000 });
}

export async function syncReservationFeed(ctx: ReservationActorContext, feedId: string, deps: Deps = {}) {
  allowed(ctx, "configure"); z.uuid().parse(feedId);
  const db = database(deps), now = deps.now ?? new Date(), metadata = await meta(deps);
  const claim = await withTenant(db, ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), feed = await repository.feed(feedId);
    if (!feed) throw new ReservationNotFoundError();
    const property = await repository.property(feed.propertyId);
    if (!property) throw new ReservationNotFoundError();
    allowed(ctx, "configure", feed.propertyId, undefined, undefined, property); allowed(ctx, "create", feed.propertyId, undefined, undefined, property); allowed(ctx, "edit", feed.propertyId, undefined, undefined, property);
    if (feed.channel.status !== "ACTIVE" || !feed.channel.importEnabled || feed.channel.syncMode !== "ICAL" || !feed.channel.syncEndpointEncrypted) return null;
    const policy = await repository.feedPolicy(feed.propertyId, now), token = await repository.claimFeed(feed.id, now);
    return token ? { feed, token, property, policy } : null;
  });
  if (!claim) return { status: "BUSY", imported: 0, modified: 0, suspected: 0 };
  const counts = { imported: 0, modified: 0, suspected: 0 };
  let safeError = "feed_transport_failed";
  try {
    const response = await (deps.transport ?? fetchIcalFeed)(decryptSecret(claim.feed.channel.syncEndpointEncrypted!), { etag: claim.feed.etag, lastModified: claim.feed.lastModified });
    if (![200, 304].includes(response.status)) { safeError = `feed_http_${response.status}`; throw new Error(safeError); }
    let entries: NormalizedReservation[] = [];
    if (response.status === 200) {
      try { entries = new ICalAdapter().normalize({ content: response.content, source: claim.feed.source as NormalizedReservation["source"], timezone: claim.property.timezone }); }
      catch { safeError = "feed_invalid_calendar"; throw new Error(safeError); }
    }
    safeError = "feed_apply_failed";
    const result = await withTenant(db, ctx.organizationId, async tx => {
      const repository = new ReservationRepository(tx, ctx.organizationId);
      await repository.lockProperty(claim.feed.propertyId);
      const current = await repository.feed(feedId);
      if (!current || current.leaseToken !== claim.token || !current.enabled || current.archivedAt) throw new ReservationConflictError("feed_lease_changed");
      const cached = await repository.feedEntries(feedId), seen = new Set<string>();
      if (response.status === 200) {
        for (const entry of entries) {
          const key = externalKey(entry), prior = cached.find(row => row.externalKey === key), contentHash = normalizedHash(entry);
          seen.add(key);
          if (prior?.suppressed) { await repository.recordFeedEntry(feedId, key, { reservationId: prior.reservationId, blockId: prior.blockId, contentHash: prior.contentHash, sequence: prior.sequence, lastSeenAt: now }); continue; }
          if (prior && prior.sequence !== null && entry.sequence !== null && entry.sequence < prior.sequence) continue;
          let reservationId = prior?.reservationId ?? null, blockId = prior?.blockId ?? null;
          if (prior && ((prior.reservationId && entry.kind !== "reservation") || (prior.blockId && entry.kind !== "block"))) {
            await repository.exception(claim.feed.propertyId, prior.reservationId, "SOURCE_IDENTITY_REVIEW", `source-kind:${feedId}:${key}`, { feedId, entryId: prior.id, incomingKind: entry.kind }, ctx.actorId);
            await repository.recordFeedEntry(feedId, key, { reservationId, blockId, contentHash: prior.contentHash, sequence: prior.sequence, lastSeenAt: now });
            continue;
          }
          if (!prior || prior.contentHash !== contentHash) {
            if (prior?.blockId) {
              const block = await repository.block(prior.blockId);
              if (!block) throw new ReservationNotFoundError();
              await repository.updateBlock(block.id, { checkIn: dateToUtc(entry.checkIn), checkOut: dateToUtc(entry.checkOut), status: entry.cancelled ? "CANCELLED" : "ACTIVE" });
              counts.modified++;
            } else {
              const result = await ingestEntry(tx, ctx, claim.feed.propertyId, entry, `feed:${feedId}:${key}:${contentHash}`, metadata, prior?.reservationId);
              reservationId = result.reservationId; blockId = result.blockId; counts.imported += Number(result.created); counts.modified += Number(result.modified);
            }
          }
          await repository.recordFeedEntry(feedId, key, { reservationId, blockId, contentHash, sequence: entry.sequence, lastSeenAt: now });
          if (reservationId && prior?.missingRuns) { await repository.updateReservation(reservationId, { cancellationSuspectedAt: null }); await repository.resolveExceptionKey(`missing:${feedId}:${key}`, ctx.actorId, "Entry reappeared in a successful sync"); }
        }
        for (const prior of cached) if (!seen.has(prior.externalKey) && !prior.suppressed) {
          const missing = await repository.missingFeedEntry(prior.id);
          if (missing.missingRuns < claim.policy.missing_uid_runs) continue;
          const reservation = prior.reservationId ? await repository.reservation(prior.reservationId) : null;
          const block = prior.blockId ? await repository.block(prior.blockId) : null;
          const end = reservation?.checkOut ?? block?.checkOut;
          if (!end || end.toISOString().slice(0, 10) < localDate(now, claim.property.timezone) || (reservation && terminalStates.includes(reservation.status))) continue;
          if (reservation) await repository.updateReservation(reservation.id, { cancellationSuspectedAt: reservation.cancellationSuspectedAt ?? now });
          await repository.exception(claim.feed.propertyId, reservation?.id ?? null, "MISSING_FEED_ENTRY", `missing:${feedId}:${prior.externalKey}`, { feedId, entryId: prior.id, missingRuns: missing.missingRuns, blockId: block?.id ?? null }, ctx.actorId);
          counts.suspected++;
        }
      }
      await repository.refreshConflicts(claim.feed.propertyId, ctx.actorId);
      const status = response.status === 304 ? "NOT_MODIFIED" : "SUCCESS";
      await repository.updateFeed(feedId, { etag: response.status === 304 ? claim.feed.etag : response.etag, lastModified: response.status === 304 ? claim.feed.lastModified : response.lastModified,
        lastSuccessAt: now, nextSyncAt: new Date(now.getTime() + claim.policy.interval_minutes * 60000), consecutiveFailures: 0, lastError: null, leaseToken: null, leasedUntil: null });
      await recordPropertyReservationSync(tx, ctx.organizationId, claim.feed.bookingChannelId, now, status);
      await repository.resolveExceptionKey(`feed-failed:${feedId}`, ctx.actorId, "Successful calendar sync");
      await repository.syncRun(feedId, status, counts, null, ctx.actorId);
      await audit(tx, ctx, metadata, "reservation.feed.synced", claim.feed.propertyId, feedId, null, { feedId, status, ...counts }, "Scheduled or requested sync");
      return { status, ...counts };
    }, { timeout: 120000 });
    logger.info("reservation feed sync completed", { organizationId: ctx.organizationId, requestId: metadata.requestId, jobId: feedId }, result);
    return result;
  } catch {
    await withTenant(db, ctx.organizationId, async tx => {
      const repository = new ReservationRepository(tx, ctx.organizationId), current = await repository.feed(feedId);
      if (current?.leaseToken !== claim.token) return;
      await repository.updateFeed(feedId, { consecutiveFailures: { increment: 1 }, lastError: safeError, nextSyncAt: new Date(now.getTime() + claim.policy.interval_minutes * 60000), leaseToken: null, leasedUntil: null });
      await recordPropertyReservationSync(tx, ctx.organizationId, claim.feed.bookingChannelId, now, "FAILED");
      await repository.syncRun(feedId, "FAILED", { imported: 0, modified: 0, suspected: 0 }, safeError, ctx.actorId);
      await repository.exception(claim.feed.propertyId, null, "FEED_SYNC_FAILED", `feed-failed:${feedId}`, { feedId, errorCode: safeError }, ctx.actorId);
      await audit(tx, ctx, metadata, "reservation.feed.failed", claim.feed.propertyId, feedId, null, { feedId, errorCode: safeError }, "Calendar synchronization failed");
    });
    logger.warn("reservation feed sync failed", { organizationId: ctx.organizationId, requestId: metadata.requestId, jobId: feedId }, { errorCode: safeError });
    await captureException(new Error(safeError), { source: "job", organizationId: ctx.organizationId, requestId: metadata.requestId, jobId: feedId });
    return { status: "FAILED", imported: 0, modified: 0, suspected: 0 };
  }
}

export async function scheduleReservationSyncs(organizationId: string, deps: Deps = {}) {
  const db = database(deps), now = deps.now ?? new Date();
  const feeds = await withTenant(db, organizationId, tx => new ReservationRepository(tx, organizationId).dueFeeds(now));
  const results: Array<{ status: string }> = [];
  const processFeed = async (feed: (typeof feeds)[number]) => {
    const recordDenied = async () => withTenant(db, organizationId, async tx => {
      const repository = new ReservationRepository(tx, organizationId), current = await repository.feed(feed.id);
      if (!current || (current.leasedUntil && current.leasedUntil > now)) return;
      const policy = await repository.feedPolicy(feed.propertyId, now);
      await repository.updateFeed(feed.id, { consecutiveFailures: { increment: 1 }, lastError: "feed_scheduling_not_authorized", nextSyncAt: new Date(now.getTime() + policy.interval_minutes * 60000) });
      await recordPropertyReservationSync(tx, organizationId, feed.bookingChannelId, now, "FAILED");
      await repository.syncRun(feed.id, "FAILED", { imported: 0, modified: 0, suspected: 0 }, "feed_scheduling_not_authorized", feed.createdBy);
      await repository.exception(feed.propertyId, null, "FEED_SYNC_FAILED", `feed-failed:${feed.id}`, { feedId: feed.id, errorCode: "feed_scheduling_not_authorized" }, feed.createdBy);
      await writeAuditEvent(tx, { organizationId, actorId: feed.createdBy, action: "reservation.feed.failed", resourceType: "reservation", resourceId: feed.id, propertyScopeId: feed.propertyId, after: { feedId: feed.id, errorCode: "feed_scheduling_not_authorized" }, reason: "Scheduled feed actor no longer authorized", requestId: `scheduled-feed:${feed.id}:${now.toISOString()}`, occurredAt: now });
      results.push({ status: "FAILED" });
    });
    if (!feed.createdBy) { await recordDenied(); return; }
    const account = await withTenant(db, organizationId, tx => new ReservationRepository(tx, organizationId).feedCreator(feed.createdBy!));
    if (!account || account.status !== "ACTIVE") { await recordDenied(); return; }
    const ctx: ReservationActorContext = { organizationId, actorId: feed.createdBy, personId: account.personId, authContext: await authContextForAccount(organizationId, feed.createdBy, { db }) };
    try { results.push(await syncReservationFeed(ctx, feed.id, { ...deps, db, requestId: `scheduled-feed:${feed.id}:${now.toISOString()}` })); }
    catch { await recordDenied(); logger.warn("reservation scheduled feed denied", { organizationId, jobId: feed.id }); }
    };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, feeds.length) }, async () => {
    while (cursor < feeds.length) { const feed = feeds[cursor++]; await processFeed(feed); }
  }));

  return { attempted: results.length, failed: results.filter(result => result.status === "FAILED").length };
}

export async function getReservationWorkspace(ctx: ReservationActorContext, query: unknown, deps: Deps = {}) {
  allowed(ctx, "view"); const parsed = calendarQuerySchema.parse(query);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), visibility = await visibilityForContext(tx, ctx), properties = visibility.properties;
    const selected = properties.filter(property => !parsed.propertyId || property.id === parsed.propertyId);
    const workspace = await repository.workspace(selected.map(property => property.id), dateToUtc(parsed.start), dateToUtc(parsed.end), parsed.page, visibility.where, visibility.widePropertyIds.filter(id => selected.some(property => property.id === id)), parsed.feedPage);
    const reservations = workspace.reservations.filter(row => authorize(ctx.authContext, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: row.propertyId, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region, id: row.id, reservationId: row.id, status: row.status })).map(row => present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: row.propertyId, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region, id: row.id, reservationId: row.id, status: row.status, data: row }, {
      guestName: { dataClass: "guest", requiredPermission: authorize(ctx.authContext, "view", { type: "guest", organizationId: ctx.organizationId, propertyId: row.propertyId, reservationId: row.id, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region }) ? "guest:view" : undefined },
      guestEmail: { dataClass: "guest", mask: "omit" }, guestPhone: { dataClass: "guest", mask: "omit" }
    }));
    return { ...workspace, reservations, properties };
  });
}
export async function listReservationCommandExceptions(ctx: ReservationActorContext, deps: Deps = {}) {
  allowed(ctx, "view");
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const visibility = await visibilityForContext(tx, ctx);
    return new ReservationRepository(tx, ctx.organizationId).commandExceptions(visibility.properties.map(property => property.id), visibility.where, visibility.widePropertyIds);
  });
}
export async function getReservationDetail(ctx: ReservationActorContext, id: string, deps: Deps = {}) {
  allowed(ctx, "view"); z.uuid().parse(id);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), reservation = await repository.reservation(id);
    if (!reservation) throw new ReservationNotFoundError();
    allowed(ctx, "view", reservation.propertyId, id, reservation.status, reservation.property);
    const history = await repository.history(id), canSeeGuests = authorize(ctx.authContext, "view", { type: "guest", organizationId: ctx.organizationId, propertyId: reservation.propertyId, reservationId: id, city: reservation.property.cityId ?? reservation.property.city, region: reservation.property.regionId ?? reservation.property.region });
    const canSeeMoney = authorize(ctx.authContext, "view", { type: "financial_transaction", organizationId: ctx.organizationId, propertyId: reservation.propertyId, reservationId: id, city: reservation.property.cityId ?? reservation.property.city, region: reservation.property.regionId ?? reservation.property.region });
    const safe = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: reservation.propertyId, city: reservation.property.cityId ?? reservation.property.city, region: reservation.property.regionId ?? reservation.property.region, reservationId: id, id, status: reservation.status, data: { ...reservation, financialSnapshots: history.financialSnapshots.map(snapshot => ({ ...snapshot, amount: snapshot.amount?.toString() ?? null })) } }, {
      guestName: { dataClass: "guest", requiredPermission: canSeeGuests ? "guest:view" : undefined }, guestEmail: { dataClass: "guest", mask: "omit", requiredPermission: canSeeGuests ? "guest:view" : undefined }, guestPhone: { dataClass: "guest", mask: "omit", requiredPermission: canSeeGuests ? "guest:view" : undefined }, financialSnapshots: { dataClass: "financial", mask: "omit", requiredPermission: canSeeMoney ? "financial_transaction:view" : undefined }
    });
    // Revision payloads can carry money and PII; expose safe metadata independently.
    const revisions = history.revisions.map(({ id, version, operation, reason, createdAt }) => ({ id, version, operation, reason: canSeeMoney && canSeeGuests ? reason : undefined, createdAt }));
    const stays = reservation.guestId && canSeeGuests ? (await repository.guestHistory(reservation.guestId)).filter(stay => authorize(ctx.authContext, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: stay.propertyId, reservationId: stay.id, id: stay.id, status: stay.status })).map(({ id, reference, checkIn, checkOut, status }) => ({ id, reference, checkIn, checkOut, status })) : [];
    const mergeCandidates = canSeeGuests && reservation.guestId && authorize(ctx.authContext, "view", { type: "guest", organizationId: ctx.organizationId }) && authorize(ctx.authContext, "edit", { type: "guest", organizationId: ctx.organizationId }) ? await repository.guestCandidates(reservation.guestId, deps.guestSearch?.trim().slice(0, 160) ?? reservation.guestName) : [];
    return { reservation: safe, revisions, feedEntries: history.feedEntries, stays, mergeCandidates, canSeeMoney, canSeeGuests };
  });
}

export async function createCalendarBlock(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "create"); const parsed = blockInputSchema.parse(input), metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    const property = await repository.property(parsed.propertyId);
    if (!property) throw new ReservationNotFoundError();
    allowed(ctx, "create", parsed.propertyId, undefined, undefined, property); await repository.lockProperty(parsed.propertyId);
    const block = await repository.createBlock({ ...parsed, source: "MANUAL" }, ctx.actorId);
    await repository.refreshConflicts(parsed.propertyId, ctx.actorId);
    await audit(tx, ctx, metadata, "reservation.block.created", parsed.propertyId, block.id, null, block, parsed.reason);
    return block;
  });
}
export async function updateReservationFeed(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "configure"); const parsed = z.object({ feedId: z.uuid(), enabled: z.boolean() }).parse(input), metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), feed = await repository.feed(parsed.feedId);
    if (!feed) throw new ReservationNotFoundError(); const property = await repository.property(feed.propertyId);
    if (!property) throw new ReservationNotFoundError(); allowed(ctx, "configure", feed.propertyId, undefined, undefined, property);
    await repository.updateFeed(feed.id, { enabled: parsed.enabled, leaseToken: null, leasedUntil: null, nextSyncAt: new Date() });
    await audit(tx, ctx, metadata, "reservation.feed.updated", feed.propertyId, feed.id, { enabled: feed.enabled }, { enabled: parsed.enabled }, "Change feed synchronization");
  });
}
export async function resolveReservationException(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "edit"); const parsed = z.object({ exceptionId: z.uuid(), resolution: z.string().trim().min(3).max(1000) }).parse(input), metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), exception = await repository.exceptionById(parsed.exceptionId);
    if (!exception) throw new ReservationNotFoundError(); const property = await repository.property(exception.propertyId), reservation = exception.reservationId ? await repository.reservation(exception.reservationId) : null;
    if (!property) throw new ReservationNotFoundError(); allowed(ctx, "edit", exception.propertyId, exception.reservationId ?? undefined, reservation?.status, property);
    if (["DOUBLE_BOOKING", "BLOCK_OVERLAP", "MISSING_FEED_ENTRY"].includes(exception.kind)) throw new ReservationConflictError("correct_underlying_reservation_first");
    if (exception.kind.startsWith("FINANCIAL")) financialAllowed(ctx, "reconcile", exception.propertyId, exception.reservationId ?? undefined, property);
    await repository.resolveException(exception.id, ctx.actorId, parsed.resolution);
    await audit(tx, ctx, metadata, "reservation.exception.resolved", exception.propertyId, exception.id, { status: exception.status }, { status: "RESOLVED" }, parsed.resolution);
  });
}
export async function mergeReservationGuests(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "edit"); const parsed = z.object({ fromId: z.uuid(), toId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).parse(input), metadata = await meta(deps);
  if (parsed.fromId === parsed.toId) throw new ReservationConflictError();
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    // Only organization-wide guest editors may merge a person shared across properties.
    if (!authorize(ctx.authContext, "edit", { type: "guest", organizationId: ctx.organizationId })) throw new ReservationAuthorizationError();
    await repository.lockGuestMerge();
    const [from, to] = await Promise.all([repository.guestRecord(parsed.fromId), repository.guestRecord(parsed.toId)]);
    if (!from || !to) throw new ReservationNotFoundError();
    await repository.mergeGuests(from.id, to.id);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "guest.merged", resourceType: "guest", resourceId: from.id, before: { fromId: from.id }, after: { mergedIntoId: to.id }, reason: parsed.reason, ...metadata, occurredAt: new Date() });
  });
}

export async function reviewMissingFeedEntry(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "edit"); const parsed = z.object({ exceptionId: z.uuid(), decision: z.enum(["KEEP", "CANCEL"]), reason: z.string().trim().min(3).max(1000) }).parse(input), metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), exception = await repository.exceptionById(parsed.exceptionId);
    if (!exception || exception.kind !== "MISSING_FEED_ENTRY") throw new ReservationNotFoundError();
    const property = await repository.property(exception.propertyId), reservation = exception.reservationId ? await repository.reservation(exception.reservationId) : null;
    if (!property) throw new ReservationNotFoundError(); allowed(ctx, "edit", exception.propertyId, exception.reservationId ?? undefined, reservation?.status, property);
    await repository.lockProperty(exception.propertyId);
    const entryId = z.object({ entryId: z.uuid() }).parse(exception.details).entryId, entry = await repository.feedEntry(entryId);
    if (!entry) throw new ReservationNotFoundError();
    if (parsed.decision === "CANCEL") {
      if (entry.reservationId) {
        const reservation = await repository.reservation(entry.reservationId);
        if (!reservation) throw new ReservationNotFoundError();
        if (reservation.status !== "CANCELLED") await appendChange(tx, ctx, { reservationId: reservation.id, expectedVersion: reservation.version, idempotencyKey: `missing-review:${exception.id}`, operation: "TRANSITION", status: "CANCELLED", reason: parsed.reason }, metadata);
      } else if (entry.blockId) await repository.updateBlock(entry.blockId, { status: "CANCELLED" });
    } else if (entry.reservationId) await repository.updateReservation(entry.reservationId, { cancellationSuspectedAt: null });
    await repository.suppressFeedEntry(entry.id);
    await repository.resolveException(exception.id, ctx.actorId, parsed.reason);
    await repository.refreshConflicts(exception.propertyId, ctx.actorId);
    await audit(tx, ctx, metadata, "reservation.missing_entry.reviewed", exception.propertyId, exception.id, { status: exception.status }, { decision: parsed.decision }, parsed.reason);
  });
}
export async function releaseCalendarBlock(ctx: ReservationActorContext, input: unknown, deps: Deps = {}) {
  allowed(ctx, "edit"); const parsed = z.object({ blockId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).parse(input), metadata = await meta(deps);
  return withTenant(database(deps), ctx.organizationId, async tx => {
    const repository = new ReservationRepository(tx, ctx.organizationId), block = await repository.block(parsed.blockId);
    if (!block) throw new ReservationNotFoundError(); const property = await repository.property(block.propertyId);
    if (!property) throw new ReservationNotFoundError(); allowed(ctx, "edit", block.propertyId, undefined, undefined, property); await repository.lockProperty(block.propertyId);
    await repository.updateBlock(block.id, { status: "CANCELLED" });
    await repository.refreshConflicts(block.propertyId, ctx.actorId);
    await audit(tx, ctx, metadata, "reservation.block.released", block.propertyId, block.id, { status: block.status }, { status: "CANCELLED" }, parsed.reason);
  });
}
