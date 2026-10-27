import type { Notification, OutboxEvent } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { notificationEventType, notificationInputSchema, type NotificationCursor, type NotificationInput } from "./notification";
import { Prisma } from "@prisma/client";
import { digestSettingsSchema, nextDigestAt } from "./digest";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { defaultNotificationPreferences, shouldDeliverNotification, type NotificationPreferences } from "./notification-preferences";
import { authorize } from "@/platform/authz/authorize";
import { securityEnrollment } from "@/platform/auth/security-enrollment";
import { approvalResource } from "@/platform/approvals/approval";
import { contextForRoleAssignments,authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { expenseEmergencyNoticeSchema,expenseResource,viewableExpenseResource,type ExpenseEmergencyNotice } from "@/modules/finance/domain/expense";
import { z } from "zod";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { initialNotificationRouting, notificationRoutingKey, notificationRoutingSchema, type NotificationRouting, type RoutedNotificationKind } from "./notification-routing";

type DeliveryBatch = {
  targets: Map<string, Resource>;
  routing: Map<string, NotificationRouting>;
  candidates: Map<string, Awaited<ReturnType<NotificationRepository["candidates"]>>>;
  inbox: Prisma.NotificationCreateManyInput[];
  finished: string[];
};

export class NotificationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async activeRecipient(accountId: string, lock = false) {
    if (lock) await this.tx.$queryRaw(Prisma.sql`SELECT id FROM user_account WHERE organization_id = ${this.organizationId}::uuid AND id = ${accountId}::uuid FOR UPDATE`);
    return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id: accountId, status: "ACTIVE" }, select: { id: true } });
  }

  async preferences(accountId: string): Promise<NotificationPreferences> {
    const row = await this.tx.notificationPreference.findUnique({ where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } } });
    return this.preferenceValue(row);
  }

  async savePreferences(accountId: string, preferences: NotificationPreferences, now = new Date()) {
    const previous = await this.tx.notificationPreference.findUnique({ where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } } });
    const previousDigest = previous?.digestSettings ? digestSettingsSchema.parse(previous.digestSettings) : null;
    const reschedule = preferences.digest && (JSON.stringify(previousDigest) !== JSON.stringify(preferences.digest) || previous?.emailEnabled !== (preferences.email.enabled ?? false) || previous?.emailOperations !== (preferences.email.operations ?? false));
    if (reschedule && preferences.digest?.frequency !== "off" && preferences.email.enabled && preferences.email.operations) requireCurrentTimezoneData();
    const data = { inAppEnabled: preferences.in_app.enabled, inAppAccount: preferences.in_app.account, inAppOperations: preferences.in_app.operations, inAppSecurity: true, emailSecurity: true,
      emailEnabled: preferences.email.enabled ?? false, emailAccount: preferences.email.account ?? false, emailOperations: preferences.email.operations ?? false,
      pushEnabled: preferences.push?.enabled ?? false, pushAccount: preferences.push?.account ?? false, pushOperations: preferences.push?.operations ?? false };
    const digest = preferences.digest ? { digestSettings: preferences.digest, ...(reschedule ? { digestRevision: (previous?.digestRevision ?? 0) + 1, digestNextAt: preferences.email.enabled && preferences.email.operations ? nextDigestAt(preferences.digest, now) : null } : {}) } : {};
    return this.tx.notificationPreference.upsert({
      where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } },
      create: { organizationId: this.organizationId, userAccountId: accountId, ...data, ...digest }, update: { ...data, ...digest }
    });
  }

  async deliver(event: OutboxEvent): Promise<void> {
    if (event.organizationId !== this.organizationId || event.type !== notificationEventType) throw new Error("Invalid notification event");
    // Serialize every delivery decision (including suppression) on the durable source.
    // Replays must re-read its status rather than trust a stale caller's event object.
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM outbox_event WHERE organization_id = ${this.organizationId}::uuid AND id = ${event.id}::uuid FOR UPDATE`);
    const stored = await this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id: event.id, type: notificationEventType } });
    if (!stored || stored.status === "DISPATCHED") return;
    await this.deliverLocked(stored);
  }

  private async deliverLocked(event: OutboxEvent, batch?: DeliveryBatch): Promise<void> {
    const input = notificationInputSchema.parse(event.payload);
    const financialNotice=input.kind==="expense_emergency"?await this.expenseEmergencySource(event,input):null;
    const target = financialNotice?.target ?? (batch ? batch.targets.get(`${input.kind}:${input.targetId}`) :
      (await this.targets([{ kind: input.kind, targetId: input.targetId }])).get(input.targetId));
    if(input.kind==="expense_emergency"&&!financialNotice)return this.finish(event.id,batch);
    if (!target) return this.finish(event.id, batch);
    if (input.kind === "task_assigned" && target.assignedUserAccountId !== input.recipientId) return this.finish(event.id, batch);
    const identity = target.type === "identity";
    if (identity && input.targetId !== input.recipientId) throw new Error("Invalid notification subject");
    const approval = input.kind === "approval_requested" ? await this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, id: input.targetId },
      include: { recipients: true, financialStages: { orderBy: { position: "asc" }, include: { recipients: true } } } }) : null;
    const stage = approval?.financialStages.find(stage => stage.state === "PENDING");
    if ((approval?.expenseId || approval?.payoutId) && (!stage || approval.state !== "PENDING")) return this.finish(event.id, batch);
    const approvalRecipients = stage?.recipients ?? approval?.recipients;
    const routingKey = JSON.stringify([input.kind, target.propertyId, event.occurredAt]);
    let routing:NotificationRouting;
    if(input.kind==="expense_emergency")routing=financialNotice!.notice.routing;
    else routing=approval?notificationRoutingSchema.parse(stage?.routingSnapshot??approval.routingSnapshot):batch?.routing.get(routingKey)??await this.routing(input.kind,target.propertyId??null,event.occurredAt);
    if (batch && !approval&&!financialNotice) batch.routing.set(routingKey, routing);
    const mandatory = input.kind === "security_session_revoked";
    const assignedId = identity ? input.targetId : target.assignedUserAccountId;
    const recipientIds = financialNotice?[input.recipientId]:approvalRecipients?.map((row) => row.userAccountId);
    const selectedId = (mandatory || routing.assigned) ? assignedId : null;
    const candidateKey = JSON.stringify([routing, selectedId, recipientIds]);
    const candidates = batch?.candidates.get(candidateKey) ?? await this.candidates(financialNotice?{...routing,roles:[],people:[],assigned:false}:routing, selectedId, recipientIds,Boolean(financialNotice));
    if (batch) batch.candidates.set(candidateKey, candidates);
    const data = [];
    for (const candidate of candidates) {
      // Account notices never reveal one person's security/account activity to another.
      if (identity && candidate.id !== input.targetId) continue;
      if(financialNotice&&candidate.id!==input.recipientId)continue;
      if (approval && !approvalRecipients?.some((row) => row.userAccountId === candidate.id)) continue;
      const selected = (mandatory || routing.assigned) && candidate.id === assignedId;
      const explicit = routing.people.includes(candidate.personId);
      const roleAssignments = candidate.roleAssignments.filter((assignment) => routing.roles.includes(assignment.role.id));
      const current=financialNotice?await new IdentityRepository(this.tx,this.organizationId).authorizationState(candidate.id):null;
      const ctx = contextForRoleAssignments(this.organizationId, candidate.id, current?current.assignments:explicit || selected || approval ? candidate.roleAssignments : roleAssignments);
      if(current&&(!current.account||securityEnrollment(current.account,current.now).setupRequired))continue;
      if (!identity && !current&&securityEnrollment(candidate).setupRequired) continue;
      if (!identity && !authorize(ctx, "view", target,current?.now)) continue;
      if (approval && !authorize(ctx, "approve", target) && !authorize(ctx, "reject", target)) continue;
      for (const channel of ["email", "push"] as const) {
        if ((!mandatory && !routing.channels.includes(channel)) || !shouldDeliverNotification(input.kind, channel, this.preferenceValue(candidate.notificationPreference))) continue;
        await this.tx.outboxEvent.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey: `notification:${event.id}:${candidate.id}:${channel}` } }, update: {},
          create: { organizationId: this.organizationId, type: "notification.channel.requested", payload: { channel, recipientId: candidate.id, kind: input.kind, targetId: input.targetId, sourceEventId: event.id }, idempotencyKey: `notification:${event.id}:${candidate.id}:${channel}` } });
      }
      if (!mandatory && !financialNotice&&(!routing.channels.includes("in_app") || !shouldDeliverNotification(input.kind, "in_app", this.preferenceValue(candidate.notificationPreference)))) continue;
      data.push({ organizationId: this.organizationId, recipientId: candidate.id,
        eventId: event.id, kind: input.kind, targetId: input.targetId, createdAt: event.occurredAt });
    }
    if (batch) batch.inbox.push(...data);
    else if (data.length) await this.tx.notification.createMany({ data, skipDuplicates: true });
    await this.finish(event.id, batch);
  }

  private async expenseEmergencySource(event:OutboxEvent,input:Extract<NotificationInput,{kind:"expense_emergency"}>) {
    const expense=await this.tx.expense.findFirst({where:{organizationId:this.organizationId,id:input.targetId,property:{archivedAt:null}},include:{property:true,submission:true}});
    const snapshot=z.object({postHocOwnerNotificationRequired:z.literal(true),postHocNotices:z.array(expenseEmergencyNoticeSchema).min(1)}).safeParse(expense?.submission?.snapshot);
    if(!expense||!snapshot.success)return null;
    const notice=snapshot.data.postHocNotices.find(notice=>notice.recipients.includes(input.recipientId)&&event.idempotencyKey===`expense:${expense.id}:emergency:${notice.ownerId}:${input.recipientId}`);
    return notice&&notice.routing.channels.includes("in_app")?{notice,target:expenseResource(this.organizationId,expense.property,{...expense,amount:expense.amount.toString()},notice.ownerId)}:null;
  }

  async publishExpenseEmergencyNotices(expenseId:string,notices:ExpenseEmergencyNotice[]) {
    const entries=notices.flatMap(notice=>notice.recipients.map(recipientId=>({input:{kind:"expense_emergency" as const,recipientId,targetId:expenseId},key:`expense:${expenseId}:emergency:${notice.ownerId}:${recipientId}`})));
    await this.publishMany(entries);
    const events=await this.tx.outboxEvent.findMany({where:{organizationId:this.organizationId,idempotencyKey:{in:entries.map(entry=>entry.key)}}});
    const receipts=await this.tx.notification.findMany({where:{organizationId:this.organizationId,kind:"expense_emergency",targetId:expenseId,eventId:{in:events.map(event=>event.id)}}});
    for(const notice of notices)if(!receipts.some(receipt=>notice.recipients.includes(receipt.recipientId)&&events.some(event=>event.id===receipt.eventId&&event.idempotencyKey===`expense:${expenseId}:emergency:${notice.ownerId}:${receipt.recipientId}`)))
      throw new Error("Required emergency owner notice was not delivered");
    return {count:receipts.length};
  }

  finish(id: string, batch?: DeliveryBatch) {
    if (batch) { batch.finished.push(id); return Promise.resolve(); }
    return this.tx.outboxEvent.update({ where: { id, organizationId: this.organizationId }, data: { status: "DISPATCHED", processedAt: new Date(), nextAttemptAt: null, lastError: null } }).then(() => undefined);
  }

  private preferenceValue(row: { inAppEnabled: boolean; inAppAccount: boolean; inAppOperations: boolean; emailEnabled?: boolean; emailAccount?: boolean; emailOperations?: boolean; pushEnabled?: boolean; pushAccount?: boolean; pushOperations?: boolean; digestSettings?: unknown } | null): NotificationPreferences {
    return row ? { ...(row.digestSettings ? { digest: digestSettingsSchema.parse(row.digestSettings) } : {}), in_app: { enabled: row.inAppEnabled, account: row.inAppAccount, operations: row.inAppOperations, security: true },
      email: { security: true, ...(row.emailEnabled || row.emailAccount || row.emailOperations ? { enabled: row.emailEnabled ?? false, account: row.emailAccount ?? false, operations: row.emailOperations ?? false } : {}) },
      ...(row.pushEnabled || row.pushAccount || row.pushOperations ? { push: { enabled: row.pushEnabled ?? false, account: row.pushAccount ?? false, operations: row.pushOperations ?? false } } : {}) } : defaultNotificationPreferences();
  }

  async approvers(routing: NotificationRouting, resource: Resource): Promise<string[]> {
    const candidates = await this.candidates(routing);
    return candidates.filter((candidate) => {
      const assignments = routing.people.includes(candidate.personId) ? candidate.roleAssignments : candidate.roleAssignments.filter((assignment) => routing.roles.includes(assignment.role.id));
      const ctx = contextForRoleAssignments(this.organizationId, candidate.id, assignments);
      return !securityEnrollment(candidate).setupRequired && authorize(ctx, "view", resource) && (authorize(ctx, "approve", resource) || authorize(ctx, "reject", resource));
    }).map((candidate) => candidate.id);
  }
  async viewers(routing:NotificationRouting,resource:Resource):Promise<string[]> {
    const candidates=await this.candidates(routing,undefined,undefined,true),current=await new IdentityRepository(this.tx,this.organizationId).authorizationStates(candidates.map(candidate=>candidate.id));
    return candidates.filter(candidate=>{
      const state=current.states.get(candidate.id);if(!state?.account||securityEnrollment(state.account,current.now).setupRequired)return false;
      const assignments=routing.people.includes(candidate.personId)?state.assignments:state.assignments.filter(assignment=>routing.roles.includes(assignment.role.id));
      return authorize(contextForRoleAssignments(this.organizationId,candidate.id,assignments),"view",resource,current.now);
    }).map(candidate=>candidate.id);
  }

  async manualRecipients(kind: RoutedNotificationKind, resource: Resource) {
    const routing = await this.routing(kind, resource.propertyId ?? null);
    const assignedId = routing.assigned ? resource.assignedUserAccountId : null;
    const candidates = await this.candidates(routing, assignedId);
    return candidates.filter((candidate) => {
      const selected = candidate.id === assignedId || routing.people.includes(candidate.personId);
      const assignments = selected ? candidate.roleAssignments : candidate.roleAssignments.filter((assignment) => routing.roles.includes(assignment.role.id));
      return !securityEnrollment(candidate).setupRequired && authorize(contextForRoleAssignments(this.organizationId, candidate.id, assignments), "view", resource);
    });
  }

  private candidates(routing: NotificationRouting, assignedId?: string | null, recipientIds?: string[],authoritative=false) {
    const now = new Date();
    return this.tx.userAccount.findMany({ where: { organizationId: this.organizationId, status: "ACTIVE", person: { archivedAt: null }, OR: [
      ...(assignedId ? [{ id: assignedId }] : []), ...(recipientIds ? [{ id: { in: recipientIds } }] : []), { personId: { in: routing.people } },
      { roleAssignments: { some: { organizationId: this.organizationId, archivedAt: null, roleId: { in: routing.roles }, role: { archivedAt: null }, ...(authoritative?{}:{validFrom:{lte:now},OR:[{validTo:null},{validTo:{gt:now}}]}) } } }
    ] }, include: { person: { select: { preferredLocale: true, displayName: true, phone: true } }, authCredentials: { where: { revokedAt: null }, select: { type: true, expiresAt: true, revokedAt: true } }, notificationPreference: true, roleAssignments: { where: {
      organizationId: this.organizationId, archivedAt: null, role: { archivedAt: null }, ...(authoritative?{}:{validFrom:{lte:now},OR:[{validTo:null},{validTo:{gt:now}}]})
    }, include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } } });
  }

  async routing(kind: RoutedNotificationKind, propertyId: string | null, asOf = new Date()): Promise<NotificationRouting> {
    const repository = new ConfigRuleRepository(this.tx, this.organizationId);
    const key = notificationRoutingKey(kind);
    let resolved = await repository.resolve({ key, asOf, scopes: [
      ...(propertyId ? [{ scopeType: "property", scopeId: propertyId }] : []), { scopeType: "organization", scopeId: null }
    ] });
    if (!resolved) {
      // A single tenant lock makes concurrent first-use initialization retry-safe.
      await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + key}, 0))::text`);
      const versions = await repository.list({ key, scopeType: "organization", scopeId: null, take: 1 });
      if (!versions.length) {
        await repository.createVersion({ key, scopeType: "organization", value: initialNotificationRouting(kind), effectiveFrom: new Date(0), reason: "Initialize configurable notification routing" });
      }
      // Another transaction may have initialized the rule while we waited.
      resolved = await repository.resolve({ key, asOf, scopes: [
        ...(propertyId ? [{ scopeType: "property", scopeId: propertyId }] : []), { scopeType: "organization", scopeId: null }
      ] });
    }
    // An inactive/retired/future rule is an explicit absence, never a fallback recipient list.
    return resolved ? notificationRoutingSchema.parse(resolved.parsedValue) : { roles: [], people: [], assigned: false, channels: [] };
  }

  async routingOptions() {
    const [roles, people, properties] = await Promise.all([
      this.tx.role.findMany({ where: { organizationId: this.organizationId, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      this.tx.person.findMany({ where: { organizationId: this.organizationId, archivedAt: null, userAccounts: { some: { status: "ACTIVE" } } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
      new ConfigRuleRepository(this.tx, this.organizationId).listPropertyScopeOptions()
    ]);
    return { roles, people, properties };
  }

  async validateRoutingReferences(routing: NotificationRouting, propertyId: string | null) {
    const [roles, people, property] = await Promise.all([
      this.tx.role.count({ where: { organizationId: this.organizationId, id: { in: routing.roles }, archivedAt: null } }),
      this.tx.person.count({ where: { organizationId: this.organizationId, id: { in: routing.people }, archivedAt: null, userAccounts: { some: { status: "ACTIVE" } } } }),
      propertyId ? this.tx.property.count({ where: { organizationId: this.organizationId, id: propertyId, archivedAt: null } }) : Promise.resolve(1)
    ]);
    if (!property || roles !== new Set(routing.roles).size || people !== new Set(routing.people).size) throw new Error("Invalid routing references");
  }

  async publish(input: NotificationInput, idempotencyKey: string): Promise<void> {
    const parsed = notificationInputSchema.parse(input);
    const event = await this.tx.outboxEvent.upsert({
      where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, update: {},
      create: { organizationId: this.organizationId, type: notificationEventType, payload: parsed, idempotencyKey }
    });
    // Local durable delivery is atomic with the business change. Outbox replay is safe
    // and does not depend on an external email/job provider being configured.
    await this.deliver(event);
  }

  async publishMany(entries: Array<{ input: NotificationInput; key: string }>): Promise<void> {
    if (!entries.length) return;
    const parsed = entries.map(entry => ({ input: notificationInputSchema.parse(entry.input), key: entry.key }));
    parsed.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    await this.tx.outboxEvent.createMany({ skipDuplicates: true, data: parsed.map(entry => ({
      organizationId: this.organizationId, type: notificationEventType, payload: entry.input, idempotencyKey: entry.key
    })) });
    const keys = [...new Set(parsed.map(entry => entry.key))];
    // One lock/read covers the whole command; replay still reads durable status.
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM outbox_event
      WHERE organization_id = ${this.organizationId}::uuid AND idempotency_key IN (${Prisma.join(keys)})
      ORDER BY id FOR UPDATE`);
    const events = await this.tx.outboxEvent.findMany({ where: { organizationId: this.organizationId, idempotencyKey: { in: keys } } });
    if (events.length !== keys.length || events.some(event => event.type !== notificationEventType)) throw new Error("Invalid notification event");
    const pending = events.filter(event => event.status !== "DISPATCHED");
    const inputs = pending.map(event => notificationInputSchema.parse(event.payload));
    const targets = new Map<string, Resource>();
    for (const kind of new Set(inputs.map(input => input.kind))) {
      if(kind==="expense_emergency")continue;
      for (const [id, target] of await this.targets(inputs.filter(input => input.kind === kind)))
        targets.set(`${kind}:${id}`, target);
    }
    const batch: DeliveryBatch = { targets, routing: new Map(), candidates: new Map(), inbox: [], finished: [] };
    for (const event of pending) await this.deliverLocked(event, batch);
    if (batch.inbox.length) await this.tx.notification.createMany({ data: batch.inbox, skipDuplicates: true });
    if (batch.finished.length) await this.tx.outboxEvent.updateMany({
      where: { organizationId: this.organizationId, id: { in: batch.finished } },
      data: { status: "DISPATCHED", processedAt: new Date(), nextAttemptAt: null, lastError: null }
    });
  }

  page(recipientId: string, cursor?: NotificationCursor | null) {
    return this.tx.notification.findMany({ where: { organizationId: this.organizationId, recipientId,
      ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  unreadCount(recipientId: string) {
    return this.tx.notification.count({ where: { organizationId: this.organizationId, recipientId, readAt: null } });
  }
  find(recipientId: string, id: string) {
    return this.tx.notification.findFirst({ where: { organizationId: this.organizationId, recipientId, id } });
  }
  findSource(recipientId: string, eventId: string) {
    return this.tx.notification.findFirst({ where: { organizationId: this.organizationId, recipientId, eventId } });
  }
  markRead(recipientId: string, id: string, readAt: Date) {
    return this.tx.notification.updateMany({ where: { organizationId: this.organizationId, recipientId, id, readAt: null }, data: { readAt } });
  }

  async targets(rows: Pick<Notification, "kind" | "targetId">[], readerId?: string): Promise<Map<string, Resource>> {
    const ids = rows.filter((row) => row.kind === "task_assigned" || (row.kind === "task_completed" || row.kind === "task_overdue")).map((row) => row.targetId);
    const tasks = ids.length ? await this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null },
      select: { id: true, propertyId: true, state: true, assignedToUserAccountId: true, property: { select: { regionId: true, cityId: true } } } }) : [];
    const targets = new Map<string, Resource>(tasks.map((task) => [task.id, {
      type: "task", organizationId: this.organizationId, id: task.id, taskId: task.id, jobId: task.id,
      propertyId: task.propertyId, region: task.property.regionId, city: task.property.cityId,
      status: task.state, assignedUserAccountId: task.assignedToUserAccountId
    }]));
    for (const row of rows) if (row.kind === "language_updated" || row.kind === "security_session_revoked") targets.set(row.targetId, { type: "identity", organizationId: this.organizationId, id: row.targetId });
    const documentIds = rows.filter(row => row.kind === "staff_document_expiring").map(row => row.targetId);
    const documents = documentIds.length ? await this.tx.teamDocument.findMany({ where: { organizationId: this.organizationId, id: { in: documentIds }, archivedAt: null, confirmedAt: { not: null }, person: { archivedAt: null } }, select: { id: true, personId: true } }) : [];
    for (const row of documents) targets.set(row.id, { type: "staff_document", organizationId: this.organizationId, id: row.personId, documentId: row.id, assignedPersonId: row.personId });
    const reservationIds = rows.filter((row) => row.kind === "reservation_created").map((row) => row.targetId);
    const reservations = reservationIds.length ? await this.tx.reservation.findMany({ where: { organizationId: this.organizationId, id: { in: reservationIds }, archivedAt: null }, select: { id: true, propertyId: true, status: true, property: { select: { regionId: true, cityId: true } } } }) : [];
    for (const row of reservations) targets.set(row.id, { type: "reservation", organizationId: this.organizationId, id: row.id, reservationId: row.id, propertyId: row.propertyId, region: row.property.regionId, city: row.property.cityId, status: row.status });
    const approvalIds = rows.filter((row) => row.kind === "approval_requested" || row.kind === "approval_decided").map((row) => row.targetId);
    const approvals = approvalIds.length ? await this.tx.approvalRequest.findMany({ where: { organizationId: this.organizationId, id: { in: approvalIds }, property: { archivedAt: null } },
      include: { property: true, expense: true, payout: true, financialStages: { orderBy: { position: "asc" }, include: { recipients: true } } } }) : [];
    for (const row of approvals) {
      const ownStage = readerId ? row.financialStages.find(stage => stage.recipients.some(recipient => recipient.userAccountId === readerId)) : undefined;
      targets.set(row.id, { ...approvalResource(row, ownStage?.ownerId ?? row.financialStages.find(stage => stage.state === "PENDING")?.ownerId), assignedUserAccountId: row.requestedBy });
    }
    const expenseIds=rows.filter(row=>row.kind==="expense_emergency").map(row=>row.targetId);
    const expenses=expenseIds.length?await this.tx.expense.findMany({where:{organizationId:this.organizationId,id:{in:expenseIds},property:{archivedAt:null}},include:{property:true,submission:true}}):[];
    const reader=readerId&&expenses.length?await authContextForAccountInTransaction(this.tx,this.organizationId,readerId):null;
    for(const expense of expenses){
      const stored=z.object({postHocNotices:z.array(expenseEmergencyNoticeSchema)}).safeParse(expense.submission?.snapshot);
      if(!readerId||!reader||!stored.success)continue;
      const owners=stored.data.postHocNotices.filter(notice=>notice.recipients.includes(readerId)).map(notice=>notice.ownerId);
      const resource=owners.length?viewableExpenseResource(reader,expense.property,{...expense,amount:expense.amount.toString()},owners):null;
      if(resource)targets.set(expense.id,resource);
    }
    return targets;
  }
  async approvalDeliveryAllowed(approvalId: string, recipientId: string, sourceEventId?: string) {
    const row = await this.tx.approvalRequest.findFirst({ where: { organizationId: this.organizationId, id: approvalId },
      include: { recipients: true, financialStages: { orderBy: { position: "asc" }, include: { recipients: true } } } });
    if (!row || row.state !== "PENDING") return false;
    if (!row.expenseId && !row.payoutId) return row.recipients.some(recipient => recipient.userAccountId === recipientId);
    const stage = row.financialStages.find(stage => stage.state === "PENDING");
    if (!stage || !sourceEventId || !stage.recipients.some(recipient => recipient.userAccountId === recipientId)) return false;
    const event = await this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id: sourceEventId, type: notificationEventType } });
    return Boolean(event && event.idempotencyKey === `approval:${row.id}:stage:${stage.id}:requested` &&
      notificationInputSchema.safeParse(event.payload).success && (event.payload as Prisma.JsonObject).targetId === row.id);
  }

  async channelRecipient(id: string) {
    const candidates = await this.candidates({ roles: [], people: [], assigned: true, channels: [] }, id);
    return candidates.find((candidate) => candidate.id === id) ?? null;
  }

  async channelEvent(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM outbox_event WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`);
    return this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id, type: "notification.channel.requested" } });
  }
}
