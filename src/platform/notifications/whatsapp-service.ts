import { createTranslator } from "next-intl";
import { createHash } from "node:crypto";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import ar from "../../../messages/ar.json";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { assertInbox, NotificationAccessError, type NotificationActor } from "./notification-service";
import { NotificationRepository } from "./notification-repository";
import { notificationDestination, notificationInputSchema } from "./notification";
import { WhatsappRepository } from "./whatsapp-repository";
import { whatsappContactSchema, whatsappPhone, whatsappRequestSchema, whatsappSourceSchema, whatsappUrl, type WhatsappOption, type WhatsappSource } from "./whatsapp";

type Deps = { db?: TenantTransactionRunner; requestId?: string; fingerprint?: string };
export class WhatsappPhoneError extends Error {
  constructor(readonly code: "missingPhone" | "invalidPhone") { super(code); }
}

async function choices(tx: TenantTransaction, actor: NotificationActor, source: WhatsappSource) {
  const inbox = new NotificationRepository(tx, actor.organizationId);
  if (actor.accountId !== actor.authContext.userAccountId || actor.organizationId !== actor.authContext.organizationId || !await inbox.activeRecipient(actor.accountId)) throw new NotificationAccessError();
  let canonical = source;
  let kind: "reservation_created" | "task_assigned" | "task_completed" = source.type === "reservation" ? "reservation_created" : "task_assigned";
  if (source.type === "notification") {
    assertInbox(actor, "view");
    const row = await inbox.find(actor.accountId, source.id);
    if (!row || !["reservation_created", "task_assigned", "task_completed"].includes(row.kind)) throw new NotificationAccessError();
    const input = notificationInputSchema.parse({ kind: row.kind, recipientId: row.recipientId, targetId: row.targetId });
    const target = (await inbox.targets([row])).get(row.targetId);
    if (!notificationDestination(actor.authContext, input, target ?? null, "en")) throw new NotificationAccessError();
    kind = row.kind as typeof kind;
    canonical = { type: kind === "reservation_created" ? "reservation" : "task", id: row.targetId };
  }
  const repository = new WhatsappRepository(tx, actor.organizationId);
  const task = canonical.type === "task" ? await repository.task(canonical.id) : null;
  const reservation = canonical.type === "reservation" ? await repository.reservation(canonical.id) : null;
  const record = task ?? reservation;
  if (!record) throw new NotificationAccessError();
  const resource: Resource = { type: canonical.type, organizationId: actor.organizationId, id: record.id, propertyId: record.propertyId,
    region: record.property.regionId, city: record.property.cityId, reservationId: reservation?.id ?? task?.reservationId,
    taskId: task?.id, jobId: task?.id, assignedUserAccountId: task?.assignedToUserAccountId, assignedPersonId: task?.assignedToPersonId, status: task?.state ?? reservation?.status };
  if (!authorize(actor.authContext, "view", resource)) throw new NotificationAccessError();
  const output: Array<WhatsappOption & { phone: string | null }> = [];
  // Personal fields are released only after an independent, scoped permission check.
  const add = (option: WhatsappOption, phone: string | null, recipientResource: Resource, dataClass: "guest" | "personal") => {
    if (!authorize(actor.authContext, "view", recipientResource)) return;
    const data = present({ ...actor.authContext, visibleDataClasses: new Set([dataClass]) }, "view", { ...recipientResource, data: { name: option.name, phone } },
      { name: { dataClass, mask: "omit" }, phone: { dataClass, mask: "omit" } });
    if (typeof data.name === "string") output.push({ ...option, name: data.name, phone: data.phone ?? null });
  };
  if (reservation) add({ kind: "guest", id: reservation.id, name: reservation.guestName, locale: safeLocale(reservation.guestPreferredLocale) }, reservation.guestPhone, { ...resource, type: "guest" }, "guest");
  const owners = await repository.owners(record.propertyId);
  for (const { owner } of owners) add({ kind: "owner", id: owner.id, name: owner.displayName, locale: safeLocale(owner.preferredLocale) }, owner.phone, { ...resource, type: "owner", id: owner.id, ownerId: owner.id }, "personal");
  // Routing selection and each recipient's current record access are shared with event delivery.
  // Task assignment permission is required to disclose colleagues' contact details.
  if (authorize(actor.authContext, "assign", resource)) {
    for (const candidate of await inbox.manualRecipients(kind, resource)) {
      add({ kind: "operations", id: candidate.id, name: candidate.person.displayName, locale: safeLocale(candidate.person.preferredLocale) }, candidate.person.phone,
        resource, "personal");
    }
  }
  return { output, resource, reservation, task };
}

export async function whatsappOptions(actor: NotificationActor, input: unknown, deps: Deps = {}): Promise<WhatsappOption[]> {
  return (await whatsappPage(actor, input, deps)).options;
}

export async function whatsappPage(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const source = whatsappSourceSchema.parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const { output, resource, reservation } = await choices(tx, actor, source);
    const guest = output.find((option) => option.kind === "guest");
    const editable = reservation && guest && authorize(actor.authContext, "edit", resource) && authorize(actor.authContext, "edit", { ...resource, type: "guest" });
    return { options: output.map((option) => ({ kind: option.kind, id: option.id, name: option.name, locale: option.locale })),
      contact: editable ? { phone: guest.phone ?? "", locale: safeLocale(reservation.guestPreferredLocale) } : null };
  });
}

export async function saveWhatsappGuestContact(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const request = whatsappContactSchema.parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const { output, resource, reservation } = await choices(tx, actor, request.source);
    if (!reservation || !output.some((option) => option.kind === "guest") || !authorize(actor.authContext, "edit", resource) || !authorize(actor.authContext, "edit", { ...resource, type: "guest" })) throw new NotificationAccessError();
    await new WhatsappRepository(tx, actor.organizationId).saveGuestContact(reservation.id, request.phone ?? null, request.locale);
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "reservation.guest_contact.updated", resourceType: "reservation", resourceId: reservation.id,
      propertyScopeId: resource.propertyId ?? null, before: { phone: reservation.guestPhone, locale: reservation.guestPreferredLocale }, after: { phone: request.phone ?? null, locale: request.locale }, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: new Date() });
  });
}

export async function prepareWhatsapp(actor: NotificationActor, input: unknown, deps: Deps = {}, event: "prepared" | "opened" = "prepared") {
  const request = whatsappRequestSchema.parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const { output, resource, reservation, task } = await choices(tx, actor, request.source);
    const recipient = output.find((option) => option.kind === request.recipient.kind && option.id === request.recipient.id);
    if (!recipient) throw new NotificationAccessError();
    if (!recipient.phone?.trim()) throw new WhatsappPhoneError("missingPhone");
    const phone = whatsappPhone(recipient.phone);
    if (!phone) throw new WhatsappPhoneError("invalidPhone");
    const locale = request.locale ?? recipient.locale;
    const t = createTranslator({ locale, messages: { en, fr, ar }[locale], namespace: "Whatsapp" });
    const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(value);
    // No guest names, contacts, notes, financial information or access codes in third-party messages.
    const message = reservation ? t(`templates.reservation.${recipient.kind}`, { reference: reservation.reference, checkIn: date(reservation.checkIn), checkOut: date(reservation.checkOut) }) :
      t("templates.task", { title: localizedText(task!.titleTranslations as Record<string, string>, locale), date: date(task!.dueDate) });
    const url = whatsappUrl(phone, message);
    const fingerprint = createHash("sha256").update(JSON.stringify([request.source, request.recipient, phone, message, locale])).digest("hex");
    if (event === "opened" && deps.fingerprint !== fingerprint) throw new NotificationAccessError();
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: `notification.whatsapp.${event}`, resourceType: resource.type, resourceId: resource.id ?? null,
      propertyScopeId: resource.propertyId ?? null, after: { sourceType: request.source.type, sourceId: request.source.id, recipientKind: recipient.kind, recipientId: recipient.id, locale },
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: new Date() });
    return { phone, message, locale, url, fingerprint };
  });
}
