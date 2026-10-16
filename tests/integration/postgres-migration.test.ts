import type { EmailProvider } from "@/platform/providers";
import { digestEventType } from "@/platform/notifications/digest";
import { scheduleDigests, deliverDigest, digestSettings, recordDigestReceipt } from "@/platform/notifications/digest-service";
import { saveDigestPreferences } from "@/platform/notifications/notification-service";
import { updateAccountEmail } from "@/modules/identity/application/identity-service";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import type { Session } from "next-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntegrationAuthenticator } from "./support/authenticator";
import { beginPasskeyRegistration, finishPasskeyRegistration, startTotpEnrollment, confirmTotpEnrollment, beginPasskeyAuthentication, verifyPasskeyAuthentication } from "@/modules/identity/application/identity-service";
import { authenticatePassword, authenticateMfaChallenge, beginVerifiedPasskeyLogin, validateAuthSession } from "@/platform/auth/identity-auth";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { totpCode } from "@/platform/auth/totp";
import { ResendEmailProvider, type HttpTransport } from "@/platform/providers/real";
import { createInngestOutboxHandlers } from "@/platform/events/inngest";
import { dispatchOutboxBatch } from "@/platform/events/outbox-dispatcher";
import { createInngestOutboxHandler, type InngestTransport } from "@/platform/events/inngest";
import { dispatchRequestOrganization } from "@/platform/events/inngest-functions";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import {
  IdentityAuthorizationError,
  authContextForAccount
} from "@/modules/identity/application/identity-access";
import type { CoreActorContext } from "@/modules/core/application/core-access";
import {
  CoreAuthorizationError,
  CoreValidationError,
  createManagementAgreement,
  amendManagementAgreement,
  createOwner,
  createProperty,
  getOwner,
  getProperty,
  listPropertyManagementAgreements,
  listProperties,
  transitionPropertyLifecycle,
  updatePropertyOperatingProfile,
  updatePropertyOwnership,
  upsertPropertyBookingChannel
} from "@/modules/core/application/core-service";
import {
  assignRoleToAccount,
  activateInvitation,
  createCustomRole,
  createInvitation,
  createPersonProfile,
  deactivateAccount,
  ensureStandardIdentitySetup,
  IdentityConflictError,
  issueRecoveryCode,
  listIdentityDashboard,
  resetAccountPin,
  recoverPassword,
  revokeCredential,
  revokeDevice,
  updatePersonProfile,
  updateCustomRole
} from "@/modules/identity/application/identity-service";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import {
  getOwnerStatement,
  listOwnerPortalProperties,
  OwnerPortalAuthorizationError
} from "@/modules/owner-portal/application/owner-portal-service";
import {
  ReservationRevenueAuthorizationError,
  ReservationRevenueConflictError,
  ReservationRevenueNotFoundError,
  recordReservationAccommodationRevenue,
  reverseReservationAccommodationRevenue
} from "@/modules/finance/application/reservation-revenue-service";
import {
  AirbnbSettlementAuthorizationError,
  AirbnbSettlementConflictError,
  AirbnbSettlementNotFoundError,
  importAirbnbSettlementCsv,
  listAirbnbSettlementVariances,
  reverseAirbnbSettlement
} from "@/modules/finance/application/airbnb-settlement-service";
import type { ConfigActorContext } from "@/modules/config/application/config-access";
import {
  ConfigAuthorizationError,
  ConfigValidationError,
  createConfigRuleVersion,
  getConfigAdminModel,
  retireConfigRuleVersion
} from "@/modules/config/application/config-service";
import {
  FinanceConfigAuthorizationError,
  evaluateExpensePolicy,
  planOwnerPayout
} from "@/modules/finance/application/finance-config-service";
import type { OrganizationActorContext } from "@/modules/organization/application/organization-access";
import { OrganizationAuthorizationError } from "@/modules/organization/application/organization-access";
import {
  GeographyAuthorizationError,
  GeographyConflictError,
  archiveCity,
  archiveRegion,
  createCity,
  createRegion,
  listGeography
} from "@/modules/organization/application/geography-service";
import {
  OrganizationCurrencyLockedError,
  getOrganizationSettings,
  updateOrganizationSettings
} from "@/modules/organization/application/organization-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  ReservationNotFoundError,
  completeAssignedFieldTask,
  createManualReservation,
  listAssignedFieldTasks,
  listOperationTasks
} from "@/modules/reservations/application/reservation-service";
import { pushSyncOps } from "@/modules/reservations/application/sync-service";
import { requiredAuditEventCoverage } from "@/platform/audit/audit-event-catalog";
import { REDACTED_AUDIT_VALUE, writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, permissionKey, type AuthContext, type DataClass } from "@/platform/authz/authorize";
import { hashCredentialSecret, verifyPassword } from "@/platform/auth/password";
import { present, maskedValue, type FieldPolicy, type PresentationContext } from "@/platform/authz/present";
import { coHostSpecScenarios, simulateAccess } from "@/platform/authz/simulator";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { resolveFeatureFlag } from "@/platform/config/feature-flags";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapFirstAdmin, bootstrapOrganizationId } from "../../prisma/bootstrap-admin";
import { PinSecurityRepository } from "@/modules/identity/infrastructure/pin-security-repository";
import { pinLockoutConfigKey, pinLockoutState } from "@/modules/identity/domain/pin-lockout";
import { getNotificationPage, openNotification, readNotification, NotificationAccessError, deliverNotificationEvent, publishNotification } from "@/platform/notifications/notification-service";
import { ownNotificationContext } from "@/platform/notifications/notification";
import { updateOwnPreferredLocale } from "@/modules/identity/application/identity-service";
import { revokeSession } from "@/modules/identity/application/identity-service";
import { getNotificationPreferences, saveNotificationPreferences } from "@/platform/notifications/notification-service";
import { defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { getNotificationRouting, saveNotificationRouting } from "@/platform/notifications/notification-service";
import { notificationRoutingKey, type NotificationRouting } from "@/platform/notifications/notification-routing";
import { requestApproval, decideApproval, getApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError, ApprovalConflictError } from "@/platform/approvals/approval";
import { deliverNotificationChannel, notificationChannelEventType } from "@/platform/notifications/notification-channel-service";
import webpush from "web-push";
import { deliverPushChannel } from "@/platform/notifications/push-delivery-service";
import { pushSettings, savePushSubscription, revokePushSubscription, pushRecord } from "@/platform/notifications/push-service";
import { WebPushNotificationChannel } from "@/platform/providers/web-push";
import { prepareWhatsapp, saveWhatsappGuestContact, whatsappPage, whatsappOptions, WhatsappPhoneError } from "@/platform/notifications/whatsapp-service";

let prisma: PrismaClient;
let adminPrisma: PrismaClient | undefined;
let containerName: string;
let ownsContainer = false;
let notificationTestDatabaseUrl: string;

function runNpx(args: string[], env: NodeJS.ProcessEnv): void {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;

  execFileSync(command, commandArgs, {
    env,
    stdio: "inherit"
  });
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function waitForPostgres(name: string): void {
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-d", "alvillas_os"], {
        stdio: "ignore"
      });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }

  throw new Error("PostgreSQL test container did not become ready");
}

function publishedPort(name: string): string {
  const output = docker(["port", name, "5432/tcp"]);
  const firstLine = output.split(/\r?\n/u)[0];
  const port = firstLine?.split(":").at(-1);

  if (!port) {
    throw new Error(`Could not read published PostgreSQL port from: ${output}`);
  }

  return port;
}

function migrationNames(): string[] {
  return readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function appRoleUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "alvillas_app_test";
  url.password = "alvillas_app_test";
  return url.toString();
}

const integrationActorId = "018f0a0b-0000-7000-9000-000000000701";
const integrationPersonId = "018f0a0b-0000-7000-9000-000000000702";

function actorForOrganization(
  organizationId: string,
  permissions = new Set([
    permissionKey("reservation", "view"),
    permissionKey("reservation", "create"),
    permissionKey("task", "view"),
    permissionKey("task", "create"),
    permissionKey("task", "edit")
  ])
): ReservationActorContext {
  const authContext: AuthContext = {
    organizationId,
    permissions,
    scopes: [{ organizationId }]
  };

  return {
    organizationId,
    actorId: integrationActorId,
    personId: integrationPersonId,
    authContext
  };
}

function sessionForOwnerPortal(input: {
  organizationId: string;
  userAccountId: string;
  personId: string;
  email: string;
}): Session {
  return {
    user: {
      id: input.userAccountId,
      personId: input.personId,
      organizationId: input.organizationId,
      preferredLocale: "en",
      sessionId: "integration-session",
      sessionRevoked: false,
      securitySetupRequired: false,
      email: input.email,
      name: input.email
    },
    expires: new Date("2099-01-01T00:00:00.000Z").toISOString()
  };
}

function signedLedgerAmount(row: { side: string; amount: string }): Decimal {
  const amount = new Decimal(row.amount);
  return row.side === "CREDIT" ? amount : amount.negated();
}

async function configureAppRole(databaseUrl: string): Promise<string> {
  adminPrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });

  await adminPrisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alvillas_app_test') THEN
        CREATE ROLE alvillas_app_test LOGIN;
      END IF;
    END
    $$;
  `);
  await adminPrisma.$executeRawUnsafe(
    "ALTER ROLE alvillas_app_test WITH LOGIN PASSWORD 'alvillas_app_test'"
  );
  await adminPrisma.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO alvillas_app_test");
  await adminPrisma.$executeRawUnsafe(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alvillas_app_test"
  );
  await adminPrisma.$executeRawUnsafe("REVOKE UPDATE, DELETE ON audit_log FROM alvillas_app_test");

  return appRoleUrl(databaseUrl);
}

describe("PostgreSQL baseline", () => {
  async function pushFixture() {
    const organization = await prisma.organization.create({ data: { name: `Push ${randomUUID()}` } });
    const fixture = await withTenant(prisma, organization.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: organization.id, displayName: "Push recipient", preferredLocale: "fr" } });
      const account = await tx.userAccount.create({ data: { organizationId: organization.id, personId: person.id } });
      const session = await tx.authSession.create({ data: { organizationId: organization.id, userAccountId: account.id, deviceId: "push-test", sessionVersion: 1, expiresAt: new Date(Date.now() + 3600000) } });
      await tx.notificationPreference.create({ data: { organizationId: organization.id, userAccountId: account.id, pushEnabled: true, pushAccount: true, pushOperations: true } });
      await new ConfigRuleRepository(tx, organization.id).createVersion({ key: "notification.routing.language_updated", scopeType: "organization", effectiveFrom: new Date(0), value: { roles: [], people: [], assigned: true, channels: ["in_app", "push"] }, reason: "Enable consented browser notifications" });
      return { person, account, session };
    });
    const actor = { organizationId: organization.id, accountId: fixture.account.id, sessionId: fixture.session.id,
      authContext: ownNotificationContext({ organizationId: organization.id, permissions: new Set<string>(), scopes: [] }, fixture.account.id) };
    const pair = webpush.generateVAPIDKeys();
    const env = { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: "mailto:push@example.test" };
    const deps = { db: prisma as TenantTransactionRunner, env };
    const subscription = (token: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, expirationTime: null, keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.alloc(16, 7).toString("base64url") } });
    const publish = async (key: string) => {
      await withTenant(prisma, organization.id, (tx) => publishNotification(tx, organization.id, { kind: "language_updated", recipientId: fixture.account.id, targetId: fixture.account.id }, key));
      return withTenant(prisma, organization.id, async (tx) => {
        const source = await tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: organization.id, idempotencyKey: key } } });
        return tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: organization.id, idempotencyKey: `notification:${source.id}:${fixture.account.id}:push` } } });
      });
    };
    return { ...fixture, organization, actor, env, deps, subscription, publish };
  }
  beforeAll(async () => {
    let databaseUrl = process.env.TEST_DATABASE_URL;

    if (databaseUrl) {
      const url = new URL(databaseUrl);
      if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        throw new Error("TEST_DATABASE_URL must point at a local test database");
      }
    } else {
      containerName = `alvillas-os-test-${Date.now()}`;
      docker([
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_DB=alvillas_os",
        "-p",
        "5432",
        "postgres:17-alpine"
      ]);
      ownsContainer = true;
      waitForPostgres(containerName);
      databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${publishedPort(
        containerName
      )}/alvillas_os?schema=public`;
    }

    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: databaseUrl });

    databaseUrl = await configureAppRole(databaseUrl);
    notificationTestDatabaseUrl = databaseUrl;

    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } }
    });
  }, 120000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await adminPrisma?.$disconnect();
    if (ownsContainer && containerName) {
      execFileSync("docker", ["stop", containerName], { stdio: "ignore" });
    }
  });

  async function digestFixture(language: "en" | "fr" | "ar" = "fr") {
    const organization = await prisma.organization.create({ data: { name: "Digest isolation" } });
    const fixture = await withTenant(prisma, organization.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: organization.id, displayName: "PRIVATE PERSON", preferredLocale: "en" } });
      const account = await tx.userAccount.create({ data: { organizationId: organization.id, personId: person.id, email: `${randomUUID()}@example.test` } });
      const other = await tx.userAccount.create({ data: { organizationId: organization.id, personId: person.id, email: `${randomUUID()}@example.test` } });
      const property = await tx.property.create({ data: { organizationId: organization.id, name: "PRIVATE PROPERTY", addressLine1: "PRIVATE ADDRESS", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const hidden = await tx.property.create({ data: { organizationId: organization.id, name: "HIDDEN PROPERTY", addressLine1: "SECRET", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const role = await tx.role.create({ data: { organizationId: organization.id, key: "digest-operator", name: "Operator" } });
      for (const resource of ["task", "reservation"]) {
        const permission = await tx.permission.create({ data: { organizationId: organization.id, resource, action: "view", key: `${resource}:view` } });
        await tx.rolePermission.create({ data: { organizationId: organization.id, roleId: role.id, permissionId: permission.id } });
      }
      await tx.roleAssignment.create({ data: { organizationId: organization.id, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "property", scopeId: property.id } });
      const task = await tx.operationTask.create({ data: { organizationId: organization.id, propertyId: property.id, assignedToUserAccountId: account.id, assignedToPersonId: person.id,
        titleTranslations: { en: "PRIVATE TASK", fr: "PRIVATE TASK", ar: "PRIVATE TASK" }, type: "INSPECTION", dueDate: new Date("2030-01-07T00:00:00Z"), idempotencyKey: randomUUID() } });
      const secret = await tx.operationTask.create({ data: { organizationId: organization.id, propertyId: hidden.id, titleTranslations: { en: "UNAUTHORIZED" }, type: "INSPECTION", dueDate: new Date("2030-01-07T00:00:00Z"), idempotencyKey: randomUUID() } });
      const reservation = await tx.reservation.create({ data: { organizationId: organization.id, propertyId: property.id, reference: "PRIVATE REFERENCE", source: "MANUAL", guestName: "PRIVATE GUEST", guestEmail: "private-guest@example.test", checkIn: new Date("2030-01-07Z"), checkOut: new Date("2030-01-09Z"), nights: 2, notes: "PRIVATE NOTES", idempotencyKey: randomUUID() } });
      await publishNotification(tx, organization.id, { kind: "task_assigned", recipientId: account.id, targetId: task.id }, "digest-source");
      await publishNotification(tx, organization.id, { kind: "task_assigned", recipientId: account.id, targetId: task.id }, "digest-source");
      await tx.notification.createMany({ data: [
        { organizationId: organization.id, recipientId: account.id, eventId: randomUUID(), targetId: reservation.id, kind: "reservation_created" },
        { organizationId: organization.id, recipientId: account.id, eventId: randomUUID(), targetId: secret.id, kind: "task_assigned" },
        { organizationId: organization.id, recipientId: account.id, eventId: randomUUID(), targetId: account.id, kind: "language_updated" },
        { organizationId: organization.id, recipientId: account.id, eventId: randomUUID(), targetId: task.id, kind: "task_completed", readAt: new Date() },
        { organizationId: organization.id, recipientId: other.id, eventId: randomUUID(), targetId: task.id, kind: "task_assigned" }
      ] });
      return { account, other, property, hidden, person, task, secret, reservation };
    });
    const ctx = await authContextForAccount(organization.id, fixture.account.id, { db: prisma });
    const actor = { organizationId: organization.id, accountId: fixture.account.id, authContext: ownNotificationContext(ctx, fixture.account.id) };
    const settings = { frequency: "daily" as const, language, timezone: "UTC", time: "09:00", weekday: 1, quietHours: null };
    const now = new Date("2030-01-07T08:59:00Z"); const due = new Date("2030-01-07T09:00:00Z");
    await saveDigestPreferences(actor, settings, "digest-fixture", { db: prisma, now });
    const deps = { db: prisma as TenantTransactionRunner, now: due, env: { APP_URL: "https://os.example.test" } };
    const event = async () => withTenant(prisma, organization.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { type: digestEventType } }));
    const history = async () => (await digestSettings(actor, {}, deps)).history;
    return { ...fixture, organization, actor, settings, now, due, deps, event, history };
  }

  it("schedules one localized authorized unread digest across concurrent cron runs and masks every recipient and record field", async () => {
    const f = await digestFixture();
    const results = await Promise.all([scheduleDigests(f.organization.id, f.deps), scheduleDigests(f.organization.id, f.deps)]);
    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(1);
    const event = await f.event(); const sent: Parameters<EmailProvider["send"]>[0][] = [];
    const provider: EmailProvider = { send: (email) => { sent.push(email); return Promise.resolve({ id: "resend-digest-accepted" }); } };
    await Promise.all(Array.from({ length: 3 }, () => deliverDigest(event, { ...f.deps, provider })));
    expect(sent).toHaveLength(1); expect(sent[0].locale).toBe("fr"); expect(sent[0].text).toContain("2 notifications");
    expect(sent[0].html).toContain('lang="fr"'); expect(sent[0].to).toBe(f.account.email);
    const content = `${sent[0].text} ${sent[0].html}`;
    for (const secret of ["PRIVATE", "UNAUTHORIZED", f.other.email!, f.account.email!, f.reservation.id, f.secret.id, "private-guest@example.test"]) expect(content).not.toContain(secret);
    const noticeIds = [...content.matchAll(/notifications\/open\/([a-f0-9-]+)/gu)].map((match) => match[1]);
    expect(new Set(noticeIds).size).toBe(2);
    for (const id of new Set(noticeIds)) expect(await openNotification(f.actor, id, "fr", f.deps)).toMatch(/^\/fr\/app\/(field|reservations)/u);
    const second = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } } });
    try { expect((await digestSettings(f.actor, {}, { db: second })).settings).toEqual(f.settings); } finally { await second.$disconnect(); }
    const accepted = (await f.history())[0];
    const receipt = { type: "email.delivered", created_at: f.due.toISOString(), data: { email_id: "resend-digest-accepted", tags: { template: "notification.digest", organization_id: f.organization.id, delivery_id: accepted.id } } };
    expect(await recordDigestReceipt(receipt, f.deps)).toBe(true);
    expect(await recordDigestReceipt(receipt, f.deps)).toBe(true);
    expect(await recordDigestReceipt({ ...receipt, data: { ...receipt.data, tags: { ...receipt.data.tags, organization_id: crypto.randomUUID() } } }, f.deps)).toBe(false);
    expect(await f.history()).toEqual([expect.objectContaining({ status: "DELIVERED", attemptCount: 1, deliveredAt: f.due.toISOString() })]);
    await deliverDigest(event, { ...f.deps, provider, now: new Date("2030-01-09T09:00Z") }); expect(sent).toHaveLength(1);
    expect((await scheduleDigests(f.organization.id, { ...f.deps, now: new Date("2030-01-08T09:00Z") })).scheduled).toBe(0);
    const serialized = JSON.stringify(await digestSettings(f.actor, {}, f.deps)); expect(serialized).not.toContain(f.account.email!); expect(serialized).not.toContain("resend-digest-accepted");
    const otherActor = { ...f.actor, accountId: f.other.id };
    await expect(digestSettings(otherActor, {}, f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(openNotification(otherActor, noticeIds[0], "en", f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    const foreign = await prisma.organization.create({ data: { name: "Foreign digest" } });
    await expect(digestSettings({ ...f.actor, organizationId: foreign.id }, {}, f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    const forged = await withTenant(prisma, foreign.id, (tx) => tx.outboxEvent.create({ data: { organizationId: foreign.id, type: digestEventType, payload: event.payload!, idempotencyKey: randomUUID() } }));
    await deliverDigest(forged, { ...f.deps, provider }); expect(sent).toHaveLength(1);
    const row = await withTenant(prisma, f.organization.id, (tx) => tx.notificationDelivery.findFirstOrThrow({ where: { channel: "digest" } }));
    expect(row.payloadEncrypted).not.toContain(f.account.email!); expect(row.payloadEncrypted).not.toContain("PRIVATE");
    const otherNotice = await withTenant(prisma, f.organization.id, (tx) => tx.notification.findFirstOrThrow({ where: { recipientId: f.other.id } }));
    await expect(withTenant(prisma, f.organization.id, (tx) => tx.notification.update({ where: { id: otherNotice.id }, data: { digestDeliveryId: row.id } }))).rejects.toThrow();
    const audit = await withTenant(prisma, f.organization.id, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: "notification.digest." } } }));
    expect(audit.map((row) => row.action)).toContain("notification.digest.accepted"); expect(JSON.stringify(audit)).not.toContain(f.account.email!);
    expect(audit.every((row) => row.actorId === null && (row.after as { recipientId: string }).recipientId === f.account.id)).toBe(true);
  });

  it("retries digest delivery through the shared outbox with identical bytes and a stable key after a lost provider response", async () => {
    const f = await digestFixture("ar"); await scheduleDigests(f.organization.id, f.deps);
    const requests: Array<{ body: string; key: string | undefined }> = []; let first = true;
    const transport: HttpTransport = (_url, input) => {
      requests.push({ body: input.body!, key: input.headers?.["Idempotency-Key"] });
      // The provider accepted the request, but the connection lost its response.
      if (first) { first = false; return Promise.reject(new Error(`PRIVATE ${f.account.email}`)); }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "resend-replayed" }), text: () => Promise.resolve(""), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    };
    const env = { APP_URL: "https://os.example.test", RESEND_API_KEY: "test-only-private", EMAIL_FROM: "notifications@example.test" };
    const deliveryClock = new Date(f.due);
    const handlers = createInngestOutboxHandlers(env, undefined, new ResendEmailProvider(env, transport), { db: prisma, now: deliveryClock });
    const options = { now: f.due, errorReporter: async () => {} };
    expect((await dispatchOutboxBatch(prisma, f.organization.id, handlers, options)).failed).toBe(1);
    expect((await f.history())[0]).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect((await dispatchOutboxBatch(prisma, f.organization.id, handlers, options)).dispatched).toBe(0); expect(requests).toHaveLength(1);
    deliveryClock.setTime(f.due.getTime() + 61000);
    expect((await dispatchOutboxBatch(prisma, f.organization.id, handlers, { ...options, now: deliveryClock })).dispatched).toBe(1);
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].body).toContain('"locale","value":"ar"');
    expect((await f.history())[0]).toMatchObject({ status: "ACCEPTED", attemptCount: 2 });
    const stored = await f.event(); expect(stored.status).toBe("DISPATCHED"); expect(stored.lastError).toBeNull();
    const exhausted = await digestFixture(); await scheduleDigests(exhausted.organization.id, exhausted.deps);
    let calls = 0; const provider: EmailProvider = { send: () => { calls++; return Promise.reject(new Error("lost response")); } };
    await expect(deliverDigest(await exhausted.event(), { ...exhausted.deps, provider })).rejects.toThrow("digest_delivery_retry");
    await expect(deliverDigest(await exhausted.event(), { ...exhausted.deps, provider, now: new Date(exhausted.due.getTime() + 24 * 3600000) })).rejects.toThrow("digest_delivery_failed");
    expect(calls).toBe(1); expect((await exhausted.history())[0]).toMatchObject({ status: "FAILED", errorCode: "idempotency_window_expired" });
  });

  it("suppresses queued or retrying digests after consent, language, scope, unread state or recipient changes", async () => {
    for (const scenario of ["language", "off", "channel", "scope", "role", "read", "address", "inactive"] as const) {
      const f = await digestFixture(); await scheduleDigests(f.organization.id, f.deps); const event = await f.event(); let calls = 0;
      const provider: EmailProvider = { send: () => { calls++; return Promise.reject(new Error("PRIVATE transport body")); } };
      await expect(deliverDigest(event, { ...f.deps, provider })).rejects.toThrow("digest_delivery_retry");
      if (scenario === "language" || scenario === "off") await saveDigestPreferences(f.actor, { ...f.settings, ...(scenario === "language" ? { language: "en" as const } : { frequency: "off" as const }) }, "change", { ...f.deps, now: f.due });
      else if (scenario === "channel") { const preferences = await getNotificationPreferences(f.actor, f.deps); await saveNotificationPreferences(f.actor, { ...preferences, email: { security: true, enabled: false, account: false, operations: false } }, f.deps); }
      else await withTenant(prisma, f.organization.id, async (tx) => {
        if (scenario === "scope") await tx.roleAssignment.updateMany({ where: { userAccountId: f.account.id }, data: { archivedAt: new Date() } });
        if (scenario === "role") await tx.role.updateMany({ where: { organizationId: f.organization.id, key: "digest-operator" }, data: { archivedAt: new Date() } });
        if (scenario === "read") await tx.notification.updateMany({ where: { recipientId: f.account.id, readAt: null }, data: { readAt: new Date() } });
        if (scenario === "address") await tx.userAccount.update({ where: { id: f.account.id }, data: { email: "changed@example.test" } });
        if (scenario === "inactive") await tx.userAccount.update({ where: { id: f.account.id }, data: { status: "DEACTIVATED" } });
      });
      if (scenario === "role") {
        const revokedContext = await authContextForAccount(f.organization.id, f.account.id, { db: prisma });
        const notice = await withTenant(prisma, f.organization.id, (tx) => tx.notification.findFirstOrThrow({ where: { targetId: f.task.id, recipientId: f.account.id } }));
        await expect(openNotification({ ...f.actor, authContext: ownNotificationContext(revokedContext, f.account.id) }, notice.id, "en", f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
      }
      await deliverDigest(event, { ...f.deps, provider, now: new Date(f.due.getTime() + 61000) }); expect(calls).toBe(1);
      const row = await withTenant(prisma, f.organization.id, (tx) => tx.notificationDelivery.findFirstOrThrow({ where: { channel: "digest" } }));
      expect(row.status).toBe("SUPPRESSED"); expect(row.attemptCount).toBe(1);
    }
  });

  it("persists timezone and quiet hours, defers due digests and respects read changes before the first attempt", async () => {
    const f = await digestFixture();
    await saveDigestPreferences(f.actor, { ...f.settings, timezone: "Africa/Casablanca", time: "23:00", quietHours: { start: "22:00", end: "07:00" } }, "quiet", { db: prisma, now: new Date("2030-07-07T20:00Z") });
    expect((await scheduleDigests(f.organization.id, { ...f.deps, now: new Date("2030-07-07T22:00Z") })).scheduled).toBe(0);
    const due = new Date("2030-07-08T07:00Z"); expect((await scheduleDigests(f.organization.id, { ...f.deps, now: due })).scheduled).toBe(1);
    await withTenant(prisma, f.organization.id, (tx) => tx.notification.updateMany({ where: { recipientId: f.account.id, kind: "reservation_created" }, data: { readAt: new Date() } }));
    let calls = 0; const provider: EmailProvider = { send: (email) => { calls++; expect(email.text).toContain("1 notification"); return Promise.resolve({ id: "quiet-resend" }); } };
    await deliverDigest(await f.event(), { ...f.deps, now: due, provider }); expect(calls).toBe(1);
    // Stale channel-only clients cannot overwrite newly saved digest settings.
    const beforeSave = await withTenant(prisma, f.organization.id, (tx) => tx.notificationPreference.findFirstOrThrow({ where: { userAccountId: f.account.id } }));
    await saveNotificationPreferences(f.actor, { in_app: { enabled: false, account: false, operations: false, security: true }, email: { security: true, enabled: true, account: false, operations: true } }, f.deps);
    const afterSave = await withTenant(prisma, f.organization.id, (tx) => tx.notificationPreference.findFirstOrThrow({ where: { userAccountId: f.account.id } }));
    expect(afterSave.digestRevision).toBe(beforeSave.digestRevision); expect(afterSave.digestNextAt).toEqual(beforeSave.digestNextAt);
    expect((await digestSettings(f.actor, {}, f.deps)).settings.timezone).toBe("Africa/Casablanca");
    await expect(saveDigestPreferences(f.actor, { ...f.settings, timezone: "invalid" }, "invalid", f.deps)).rejects.toThrow();
  });

  it("bounds digest target queries as inbox volume grows and keeps the scheduled claim and request immutable", async () => {
    const small = await digestFixture(); const large = await digestFixture();
    await withTenant(prisma, large.organization.id, (tx) => tx.notification.createMany({ data: Array.from({ length: 30 }, () => ({ organizationId: large.organization.id, recipientId: large.account.id,
      eventId: randomUUID(), kind: "task_assigned", targetId: large.task.id })) }));
    const measured = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } }, log: [{ emit: "event", level: "query" }] });
    const queries: string[] = []; measured.$on("query", (event) => { if (event.query.startsWith("SELECT")) queries.push(event.query); });
    try {
      await scheduleDigests(small.organization.id, { ...small.deps, db: measured }); const count = queries.length;
      queries.length = 0; await scheduleDigests(large.organization.id, { ...large.deps, db: measured });
      expect(queries.length).toBe(count); expect(count).toBeLessThan(35);
    } finally { await measured.$disconnect(); }
    const event = await large.event();
    await deliverDigest(event, { ...large.deps, provider: { send: () => Promise.resolve({ id: "immutable-digest" }) } });
    const rows = await withTenant(prisma, large.organization.id, async (tx) => ({
      delivery: await tx.notificationDelivery.findFirstOrThrow({ where: { eventId: event.id } }),
      notice: await tx.notification.findFirstOrThrow({ where: { digestDeliveryId: { not: null } } })
    }));
    for (const data of [{ payloadEncrypted: "replacement" }, { providerId: "replacement" }, { channel: "push" }, { attemptCount: 0 }, { scheduledAt: new Date() }]) {
      await expect(withTenant(prisma, large.organization.id, (tx) => tx.notificationDelivery.update({ where: { id: rows.delivery.id }, data }))).rejects.toThrow();
    }
    await expect(withTenant(prisma, large.organization.id, (tx) => tx.notification.update({ where: { id: rows.notice.id }, data: { digestDeliveryId: null } }))).rejects.toThrow();
  });

  it("changes a digest recipient account email uniquely with an audit trail while preserving account, person and session security", async () => {
    const f = await digestFixture();
    const before = await withTenant(prisma, f.organization.id, async (tx) => {
      await tx.authSession.create({ data: { organizationId: f.organization.id, userAccountId: f.account.id, deviceId: "digest-email-change-verification", sessionVersion: 1, expiresAt: new Date("2030-12-01T00:00:00Z") } });
      return { account: await tx.userAccount.findUniqueOrThrow({ where: { id: f.account.id } }), person: await tx.person.findUniqueOrThrow({ where: { id: f.person.id } }),
        sessions: await tx.authSession.findMany({ where: { userAccountId: f.account.id } }), roles: await tx.roleAssignment.findMany({ where: { userAccountId: f.account.id } }) };
    });
    const scope = { organizationId: f.organization.id };
    const permissions = new Set(["identity:edit"]);
    const actor = { organizationId: f.organization.id, actorId: f.account.id, personId: f.person.id,
      authContext: { organizationId: f.organization.id, userAccountId: f.account.id, permissions, scopes: [scope], assignments: [{ scope, permissions }] } };
    const input = { accountId: f.account.id, personId: f.person.id, email: "OWNER-INBOX@example.test", expectedEmail: f.account.email!, reason: "Owner-authorized staging inbox configuration" };
    await expect(updateAccountEmail({ ...actor, authContext: { ...actor.authContext, permissions: new Set(), assignments: [] } }, input, f.deps)).rejects.toBeInstanceOf(IdentityAuthorizationError);
    await expect(updateAccountEmail(actor, { ...input, email: f.other.email! }, f.deps)).rejects.toBeInstanceOf(IdentityConflictError);
    await expect(updateAccountEmail(actor, { ...input, expectedEmail: "changed@example.test" }, f.deps)).rejects.toBeInstanceOf(IdentityConflictError);
    await expect(updateAccountEmail(actor, { ...input, personId: randomUUID() }, f.deps)).rejects.toThrow();
    await expect(updateAccountEmail({ ...actor, organizationId: randomUUID() }, input, f.deps)).rejects.toBeInstanceOf(IdentityAuthorizationError);
    await updateAccountEmail(actor, input, f.deps); await updateAccountEmail(actor, input, f.deps);
    const after = await withTenant(prisma, f.organization.id, async (tx) => ({ account: await tx.userAccount.findUniqueOrThrow({ where: { id: f.account.id } }), person: await tx.person.findUniqueOrThrow({ where: { id: f.person.id } }),
      sessions: await tx.authSession.findMany({ where: { userAccountId: f.account.id } }), roles: await tx.roleAssignment.findMany({ where: { userAccountId: f.account.id } }),
      audit: await tx.auditLog.findMany({ where: { action: "identity.account.email.update", resourceId: f.account.id } }) }));
    const identity = (row: typeof before.account) => ({ ...row, email: undefined, updatedAt: undefined });
    expect(identity(after.account)).toEqual(identity(before.account)); expect(after.account.email).toBe("owner-inbox@example.test"); expect(after.account.updatedAt).toBeInstanceOf(Date);
    expect(after.person).toEqual(before.person); expect(after.sessions).toEqual(before.sessions); expect(after.roles).toEqual(before.roles); expect(after.audit).toHaveLength(1);
  });

  it("prepares scoped manual WhatsApp drafts with current contacts, routing, locale, minimized data and redacted audits", async () => {
    const org = await prisma.organization.create({ data: { name: "Manual WhatsApp" } });
    const foreign = await prisma.organization.create({ data: { name: "Other WhatsApp tenant" } });
    const f = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Operator", phone: "+212612345678", preferredLocale: "ar" } });
      const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      const property = await tx.property.create({ data: { organizationId: org.id, name: "Private property", addressLine1: "PRIVATE ADDRESS", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const otherProperty = await tx.property.create({ data: { organizationId: org.id, name: "Other property", addressLine1: "Other", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const reservation = await tx.reservation.create({ data: { organizationId: org.id, propertyId: property.id, reference: "RES-WA-1", source: "MANUAL", guestName: "PRIVATE GUEST", guestEmail: "private@example.test", guestPhone: "+212612345678", guestPreferredLocale: "fr", checkIn: new Date("2027-03-01Z"), checkOut: new Date("2027-03-05Z"), nights: 4, notes: "PRIVATE NOTES", idempotencyKey: randomUUID() } });
      const owner = await tx.owner.create({ data: { organizationId: org.id, displayName: "Owner", phone: "+33612345678", preferredLocale: "en" } });
      await tx.propertyOwner.create({ data: { organizationId: org.id, propertyId: property.id, ownerId: owner.id } });
      const task = await tx.operationTask.create({ data: { organizationId: org.id, propertyId: property.id, reservationId: reservation.id, assignedToUserAccountId: account.id, assignedToPersonId: person.id, titleTranslations: { en: "Inspection & review", fr: "Inspection et contrôle", ar: "فحص ومراجعة" }, type: "ARRIVAL_PREPARATION", dueDate: new Date("2027-03-01Z"), idempotencyKey: randomUUID() } });
      const role = await tx.role.create({ data: { organizationId: org.id, key: "whatsapp-operator", name: "Operator" } });
      for (const key of ["task:view", "reservation:view"]) {
        const [resource, action] = key.split(":"); const permission = await tx.permission.create({ data: { organizationId: org.id, resource, action, key } });
        await tx.rolePermission.create({ data: { organizationId: org.id, roleId: role.id, permissionId: permission.id } });
      }
      await tx.roleAssignment.create({ data: { organizationId: org.id, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "property", scopeId: property.id } });
      await new ConfigRuleRepository(tx, org.id).createVersion({ key: "notification.routing.reservation_created", scopeType: "property", scopeId: property.id, effectiveFrom: new Date(0), value: { roles: [], people: [person.id], assigned: false, channels: ["in_app"] }, reason: "Route property notifications" });
      await publishNotification(tx, org.id, { kind: "task_assigned", recipientId: account.id, targetId: task.id }, "whatsapp-task-notice");
      return { person, account, property, otherProperty, reservation, owner, task, role };
    });
    const permissions = new Set(["reservation:view", "reservation:edit", "reservation:assign", "task:view", "task:assign", "guest:view", "guest:edit", "owner:view"]);
    const actor = { organizationId: org.id, accountId: f.account.id, authContext: ownNotificationContext({ organizationId: org.id, userAccountId: f.account.id, permissions, scopes: [{ organizationId: org.id, scopeType: "property" as const, scopeId: f.property.id }] }, f.account.id) };
    const deps = { db: prisma as TenantTransactionRunner, requestId: "whatsapp-scope-test" };
    const source = { type: "reservation", id: f.reservation.id };
    const input = { source, recipient: { kind: "guest", id: f.reservation.id } };
    const options = await whatsappOptions(actor, source, deps);
    expect(options.map((option) => option.kind).sort()).toEqual(["guest", "operations", "owner"]);
    expect(JSON.stringify(options)).not.toContain("+212");
    const measured = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } }, log: [{ emit: "event", level: "query" }] });
    const queries: string[] = []; measured.$on("query", (event) => { if (event.query.startsWith("SELECT")) queries.push(event.query); });
    try {
      await whatsappOptions(actor, source, { db: measured }); const firstCount = queries.length;
      await withTenant(prisma, org.id, async (tx) => {
        const secondOwner = await tx.owner.create({ data: { organizationId: org.id, displayName: "Second owner" } });
        await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { shareBps: 5000 } });
        await tx.propertyOwner.create({ data: { organizationId: org.id, propertyId: f.property.id, ownerId: secondOwner.id, shareBps: 5000, isPrimary: false } });
      });
      queries.length = 0; await whatsappOptions(actor, source, { db: measured });
      expect(queries.length).toBe(firstCount); expect(firstCount).toBeLessThan(24);
    } finally { await measured.$disconnect(); }
    const french = await prepareWhatsapp(actor, input, deps);
    expect(french.locale).toBe("fr"); expect(french.message).toContain("Bonjour"); expect(french.message).toContain("1 mars 2027");
    for (const locale of ["en", "fr", "ar"] as const) {
      const draft = await prepareWhatsapp(actor, { ...input, locale }, deps);
      expect(new URL(draft.url).searchParams.get("text")).toBe(draft.message);
      expect(draft.message).not.toMatch(/PRIVATE|private@example|612345678/u);
    }
    expect((await prepareWhatsapp(actor, { source, recipient: { kind: "owner", id: f.owner.id } }, deps)).phone).toBe("+33612345678");
    expect((await prepareWhatsapp(actor, { source, recipient: { kind: "operations", id: f.account.id } }, deps)).locale).toBe("ar");
    const notice = await withTenant(prisma, org.id, (tx) => tx.notification.findFirstOrThrow({ where: { targetId: f.task.id } }));
    const noticeSource = { type: "notification", id: notice.id };
    expect((await prepareWhatsapp(actor, { source: noticeSource, recipient: { kind: "operations", id: f.account.id } }, deps)).message).toContain("فحص ومراجعة");
    const denied = { ...actor, authContext: ownNotificationContext({ ...actor.authContext, assignments: undefined, permissions: new Set(["reservation:view", "task:view"]), scopes: [{ organizationId: org.id, scopeType: "property", scopeId: f.property.id }] }, f.account.id) };
    expect(await whatsappOptions(denied, source, deps)).toEqual([]);
    expect((await whatsappPage(denied, source, deps)).contact).toBeNull();
    await expect(saveWhatsappGuestContact(denied, { source, phone: "+447911123456", locale: "en" }, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(prepareWhatsapp(denied, input, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    const mixedScope = { ...actor, authContext: { ...actor.authContext, assignments: [
      { permissions: new Set(["reservation:view"]), scope: { organizationId: org.id, scopeType: "property" as const, scopeId: f.property.id } },
      { permissions: new Set(["guest:view"]), scope: { organizationId: org.id, scopeType: "property" as const, scopeId: f.otherProperty.id } }
    ] } };
    expect(await whatsappOptions(mixedScope, source, deps)).toEqual([]);
    const wrongScope = { ...actor, authContext: { ...actor.authContext, assignments: undefined, scopes: [{ organizationId: org.id, scopeType: "property" as const, scopeId: f.otherProperty.id }] } };
    await expect(whatsappOptions(wrongScope, source, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(prepareWhatsapp({ ...actor, organizationId: foreign.id, authContext: { ...actor.authContext, organizationId: foreign.id } }, input, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(prepareWhatsapp(actor, { ...input, recipient: { kind: "guest", id: randomUUID() } }, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    for (const [phone, code] of [[null, "missingPhone"], ["not-a-number", "invalidPhone"]] as const) {
      await withTenant(prisma, org.id, (tx) => tx.reservation.update({ where: { id: f.reservation.id }, data: { guestPhone: phone } }));
      await expect(prepareWhatsapp(actor, input, deps)).rejects.toMatchObject({ code });
    }
    expect(new WhatsappPhoneError("invalidPhone").code).toBe("invalidPhone");
    await saveWhatsappGuestContact(actor, { source, phone: "+447911123456", locale: "en" }, deps);
    const connection = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } } });
    try { expect((await whatsappPage(actor, source, { db: connection })).contact).toEqual({ phone: "+447911123456", locale: "en" }); } finally { await connection.$disconnect(); }
    await expect(prepareWhatsapp(actor, input, { ...deps, fingerprint: french.fingerprint }, "opened")).rejects.toBeInstanceOf(NotificationAccessError);
    const updated = await prepareWhatsapp(actor, input, deps);
    expect((await prepareWhatsapp(actor, input, { ...deps, fingerprint: updated.fingerprint }, "opened")).phone).toBe("+447911123456");
    await withTenant(prisma, org.id, async (tx) => {
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id, ownerId: f.owner.id }, data: { archivedAt: new Date() } });
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id, ownerId: { not: f.owner.id } }, data: { shareBps: 10000, isPrimary: true } });
    });
    await expect(prepareWhatsapp(actor, { source, recipient: { kind: "owner", id: f.owner.id } }, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await withTenant(prisma, org.id, (tx) => tx.roleAssignment.updateMany({ where: { userAccountId: f.account.id }, data: { archivedAt: new Date() } }));
    expect((await whatsappOptions(actor, source, deps)).map((option) => option.kind)).not.toContain("operations");
    const audits = await withTenant(prisma, org.id, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: "notification.whatsapp." } } }));
    expect(audits.filter((audit) => audit.action === "notification.whatsapp.opened")).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/PRIVATE|612345678|7911123456|wa\.me|Bonjour/u);
    const contactAudit = await withTenant(prisma, org.id, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: "reservation.guest_contact.updated" } }));
    expect(JSON.stringify(contactAudit)).not.toContain("7911123456");
    await expect(withTenant(prisma, org.id, (tx) => tx.auditLog.update({ where: { id: audits[0].id }, data: { action: "changed" } }))).rejects.toThrow();
  });

  it("persists encrypted browser subscriptions with own-session authorization, tenant FKs, audited revocation and mandatory security history", async () => {
    const f = await pushFixture(); const input = f.subscription("lifecycle");
    await expect(savePushSubscription(f.actor, { ...input, keys: { ...input.keys, p256dh: "A".repeat(87) } }, f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    const saved = await savePushSubscription(f.actor, input, f.deps);
    expect(await savePushSubscription(f.actor, input, f.deps)).toEqual(saved);
    expect((await pushSettings(f.actor, {}, f.deps)).subscriptions).toHaveLength(1);
    const stored = await withTenant(prisma, f.organization.id, (tx) => tx.pushSubscription.findFirstOrThrow());
    expect(stored.encrypted).not.toContain(input.endpoint); expect(stored.encrypted).not.toContain(input.keys.auth);
    const denied = { ...f.actor, authContext: { ...f.actor.authContext, permissions: new Set<string>() } };
    await expect(savePushSubscription(denied, input, f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(pushSettings(denied, {}, f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    const other = await pushFixture();
    expect((await pushSettings(other.actor, {}, other.deps)).subscriptions).toEqual([]);
    await revokePushSubscription(other.actor, { id: saved.id, reason: "user_disabled" }, other.deps);
    expect((await pushSettings(f.actor, {}, f.deps)).subscriptions).toHaveLength(1);
    await expect(savePushSubscription({ ...f.actor, sessionId: other.session.id }, f.subscription("foreign-session"), f.deps)).rejects.toThrow();
    await expect(withTenant(prisma, other.organization.id, (tx) => tx.pushSubscription.create({ data: { organizationId: other.organization.id, userAccountId: f.account.id, sessionId: other.session.id, endpointHash: "foreign", encrypted: "invalid", vapidPublicKey: other.env.VAPID_PUBLIC_KEY } }))).rejects.toThrow();
    const second = await withTenant(prisma, f.organization.id, (tx) => tx.userAccount.create({ data: { organizationId: f.organization.id, personId: f.person.id } }));
    const secondActor = { ...f.actor, accountId: second.id, authContext: ownNotificationContext({ organizationId: f.organization.id, permissions: new Set<string>(), scopes: [] }, second.id) };
    await expect(savePushSubscription(secondActor, input, f.deps)).rejects.toThrow();
    await revokePushSubscription(f.actor, { id: saved.id, reason: "permission_revoked" }, f.deps);
    expect((await pushSettings(f.actor, {}, f.deps)).subscriptions).toEqual([]);
    await savePushSubscription(f.actor, input, f.deps);
    await saveNotificationPreferences(f.actor, { ...defaultNotificationPreferences(), in_app: { enabled: false, account: false, operations: false, security: true }, push: { enabled: false, account: false, operations: false } }, f.deps);
    await withTenant(prisma, f.organization.id, (tx) => publishNotification(tx, f.organization.id, { kind: "security_session_revoked", recipientId: f.account.id, targetId: f.account.id }, "mandatory-security"));
    expect((await getNotificationPage(f.actor, {}, f.deps)).items.map((row) => row.kind)).toEqual(["security_session_revoked"]);
    const audit = await withTenant(prisma, f.organization.id, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: "notification.push." } } }));
    expect(audit.filter((row) => row.action === "notification.push.subscribe")).toHaveLength(2);
    expect(audit.filter((row) => row.action === "notification.push.revoke")).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(input.endpoint); expect(JSON.stringify(audit)).not.toContain(input.keys.auth);
    await expect(withTenant(prisma, f.organization.id, (tx) => tx.pushSubscription.delete({ where: { id: saved.id } }))).rejects.toThrow(/cannot be deleted/u);
  });

  it("commits per-browser delivery diagnostics, retries only failed devices, invalidates 410 subscriptions and deduplicates concurrent replays", async () => {
    const f = await pushFixture();
    for (const name of ["accepted", "transient", "expired"]) await savePushSubscription(f.actor, f.subscription(name), f.deps);
    const calls: string[] = []; let fail = true;
    const channel = new WebPushNotificationChannel(f.env, (subscription, payload, options) => {
      webpush.generateRequestDetails(subscription, payload ?? undefined, options); // Real encryption/signing, test-only transport.
      const name = subscription.endpoint.split("/").at(-1)!; calls.push(name);
      if (name === "expired" || (name === "transient" && fail)) return Promise.reject(Object.assign(new Error("PRIVATE ENDPOINT MUST NOT LEAK"), { statusCode: name === "expired" ? 410 : 503, headers: { "retry-after": "120" } }));
      return Promise.resolve({ statusCode: 201, headers: {}, body: "" });
    });
    const event = await f.publish("push-delivery"); await f.publish("push-delivery"); const now = new Date();
    const handlers = { [notificationChannelEventType]: (outbox: typeof event) => deliverPushChannel(outbox, { ...f.deps, channel, now }) };
    expect(await dispatchOutboxBatch(prisma, f.organization.id, handlers, { now, errorReporter: async () => {} })).toMatchObject({ failed: 1 });
    let history = (await pushSettings(f.actor, {}, f.deps)).items;
    expect(history).toHaveLength(3); expect(history.map((row) => row.status).sort()).toEqual(["ACCEPTED", "FAILED", "PENDING"]);
    expect(JSON.stringify(history)).not.toContain("PRIVATE");
    expect((await pushSettings(f.actor, {}, f.deps)).subscriptions).toHaveLength(2);
    expect(history.find((row) => row.status === "PENDING")?.nextAttemptAt).toBe(new Date(now.getTime() + 120000).toISOString());
    fail = false; const later = new Date(now.getTime() + 120001);
    await Promise.all(Array.from({ length: 3 }, () => deliverPushChannel(event, { ...f.deps, channel, now: later }).catch((error: unknown) => { expect((error as Error).message).toBe("push_delivery_failed"); })));
    expect(calls.filter((name) => name === "accepted")).toHaveLength(1); expect(calls.filter((name) => name === "transient")).toHaveLength(2); expect(calls.filter((name) => name === "expired")).toHaveLength(1);
    history = (await pushSettings(f.actor, {}, f.deps)).items;
    const accepted = history.find((row) => row.status === "ACCEPTED")!;
    expect(await pushRecord(f.actor, accepted.id, "display", f.deps)).toMatchObject({ locale: "fr", url: "/fr/app" });
    await pushRecord(f.actor, accepted.id, "displayed", f.deps);
    await expect(pushRecord(f.actor, accepted.id, "display", f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await pushRecord(f.actor, accepted.id, "open", f.deps);
    await pushRecord(f.actor, accepted.id, "open", f.deps);
    const readAt = (await getNotificationPage(f.actor, {}, f.deps)).items[0].readAt; expect(readAt).not.toBeNull();
    const foreign = await pushFixture(); await expect(pushRecord(foreign.actor, accepted.id, "open", foreign.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    expect((await pushSettings(foreign.actor, {}, foreign.deps)).items).toEqual([]);
    await withTenant(prisma, f.organization.id, (tx) => tx.authSession.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } }));
    await expect(pushRecord(f.actor, accepted.id, "display", f.deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(withTenant(prisma, f.organization.id, (tx) => tx.notificationDelivery.update({ where: { id: accepted.id }, data: { status: "PENDING" } }))).rejects.toThrow(/cannot be rewritten/u);
    await expect(withTenant(prisma, f.organization.id, (tx) => tx.notificationDelivery.delete({ where: { id: accepted.id } }))).rejects.toThrow(/cannot be deleted/u);
  });

  it("rechecks property permissions, consent, session expiry and key rotation before network delivery, and exhausts configured retries", async () => {
    const f = await pushFixture(); const saved = await savePushSubscription(f.actor, f.subscription("scope"), f.deps);
    const task = await withTenant(prisma, f.organization.id, async (tx) => {
      const property = await tx.property.create({ data: { organizationId: f.organization.id, name: "Push villa", addressLine1: "Test", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const role = await tx.role.create({ data: { organizationId: f.organization.id, key: "push-worker", name: "Worker" } });
      const permission = await tx.permission.create({ data: { organizationId: f.organization.id, key: "task:view", resource: "task", action: "view" } });
      await tx.rolePermission.create({ data: { organizationId: f.organization.id, roleId: role.id, permissionId: permission.id } });
      const assignment = await tx.roleAssignment.create({ data: { organizationId: f.organization.id, personId: f.person.id, userAccountId: f.account.id, roleId: role.id, scopeType: "property", scopeId: property.id } });
      const task = await tx.operationTask.create({ data: { organizationId: f.organization.id, propertyId: property.id, type: "CLEANING", state: "PLANNED", assignedToUserAccountId: f.account.id, dueDate: new Date(), titleTranslations: { en: "Test", fr: "Test" }, idempotencyKey: randomUUID() } });
      await new ConfigRuleRepository(tx, f.organization.id).createVersion({ key: "notification.routing.task_assigned", scopeType: "organization", effectiveFrom: new Date(0), value: { roles: [], people: [], assigned: true, channels: ["push"] }, reason: "Task browser routing" });
      await publishNotification(tx, f.organization.id, { kind: "task_assigned", recipientId: f.account.id, targetId: task.id }, "task-push");
      return { task, assignment };
    });
    const event = await withTenant(prisma, f.organization.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { type: notificationChannelEventType, status: "PENDING" } }));
    await withTenant(prisma, f.organization.id, (tx) => tx.roleAssignment.update({ where: { id: task.assignment.id }, data: { archivedAt: new Date() } }));
    let calls = 0; const channel = { notify: () => { calls++; return Promise.reject(new Error("private transport")); } };
    await deliverPushChannel(event, { ...f.deps, channel }); expect(calls).toBe(0);
    expect((await pushSettings(f.actor, {}, f.deps)).items[0].status).toBe("SUPPRESSED");
    await withTenant(prisma, f.organization.id, async (tx) => { await new ConfigRuleRepository(tx, f.organization.id).createVersion({ key: "notification.push.delivery_policy", scopeType: "organization", effectiveFrom: new Date(0), value: { maxAttempts: 2, backoffSeconds: 1, maxBackoffSeconds: 1, ttlSeconds: 60 }, reason: "Test retry exhaustion" }); });
    const retry = await f.publish("retry-exhaustion"); const now = new Date();
    await expect(deliverPushChannel(retry, { ...f.deps, channel, now })).rejects.toThrow("push_delivery_retry");
    await expect(deliverPushChannel(retry, { ...f.deps, channel, now: new Date(now.getTime() + 1001) })).rejects.toThrow("push_delivery_failed"); expect(calls).toBe(2);
    const rotation = await f.publish("rotated-keys"); const pair = webpush.generateVAPIDKeys();
    const rotatedDeps = { ...f.deps, env: { ...f.env, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey } };
    await expect(savePushSubscription(f.actor, f.subscription("scope"), rotatedDeps)).rejects.toThrow(/must be renewed/u);
    expect((await pushSettings(f.actor, {}, rotatedDeps)).subscriptions).toHaveLength(0);
    await deliverPushChannel(rotation, { ...rotatedDeps, channel }); expect(calls).toBe(2);
    expect((await pushSettings(f.actor, {}, f.deps)).subscriptions).toHaveLength(0);
    await savePushSubscription(f.actor, f.subscription("scope"), f.deps);
    const consent = await f.publish("withdrawn-consent");
    await saveNotificationPreferences(f.actor, { ...defaultNotificationPreferences(), push: { enabled: false, account: false, operations: false } }, f.deps);
    await deliverPushChannel(consent, { ...f.deps, channel }); expect(calls).toBe(2);
    await revokePushSubscription(f.actor, { id: saved.id, reason: "logout" }, f.deps);
    await saveNotificationPreferences(f.actor, { ...defaultNotificationPreferences(), push: { enabled: true, account: true, operations: true } }, f.deps);
    const none = await f.publish("no-active-browser"); await deliverPushChannel(none, { ...f.deps, channel });
    expect((await pushSettings(f.actor, {}, f.deps)).items[0].status).toBe("NO_SUBSCRIPTION");
  });

  it("persists authorized tenant preferences, rejects invalid and mandatory opt-outs, and audits serialized changes", async () => {
    const org = await prisma.organization.create({ data: { name: `Preference test ${randomUUID()}` } });
    const other = await prisma.organization.create({ data: { name: `Preference isolation ${randomUUID()}` } });
    const fixture = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Preferences" } });
      const one = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      const two = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      return { one, two };
    });
    const actor = { organizationId: org.id, accountId: fixture.one.id,
      authContext: ownNotificationContext({ organizationId: org.id, permissions: new Set<string>(), scopes: [] }, fixture.one.id) };
    const deps = { db: prisma as TenantTransactionRunner, requestId: randomUUID() };
    const defaults = defaultNotificationPreferences();
    const changed = { ...defaults, in_app: { ...defaults.in_app, account: false } };
    expect(await getNotificationPreferences(actor, deps)).toEqual(defaults);
    const denied = [
      { ...actor, organizationId: other.id },
      { ...actor, accountId: fixture.two.id },
      { ...actor, authContext: { ...actor.authContext, permissions: new Set<string>(), assignments: [] } },
      { ...actor, authContext: { ...actor.authContext, scopes: [], assignments: [{ scope: { organizationId: other.id }, permissions: actor.authContext.permissions }] } },
      { ...actor, organizationId: other.id, authContext: ownNotificationContext({ organizationId: other.id, permissions: new Set<string>(), scopes: [] }, fixture.one.id) }
    ];
    for (const forbidden of denied) {
      await expect(getNotificationPreferences(forbidden, deps)).rejects.toBeInstanceOf(NotificationAccessError);
      await expect(saveNotificationPreferences(forbidden, changed, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    }
    await saveNotificationPreferences(actor, changed, deps);
    for (const invalid of [{ ...changed, userAccountId: fixture.two.id }, { ...changed, in_app: { ...changed.in_app, security: false } },
      { ...changed, email: { security: false } }, { ...changed, push: true }, { in_app: {} }]) {
      await expect(saveNotificationPreferences(actor, invalid, deps)).rejects.toThrow();
      expect(await getNotificationPreferences(actor, deps)).toEqual(changed);
    }
    const fresh = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } } });
    try { expect(await getNotificationPreferences(actor, { db: fresh })).toEqual(changed); } finally { await fresh.$disconnect(); }
    expect(await getNotificationPreferences({ ...actor, accountId: fixture.two.id,
      authContext: ownNotificationContext({ organizationId: org.id, permissions: new Set<string>(), scopes: [] }, fixture.two.id) }, deps)).toEqual(defaults);
    await withTenant(prisma, other.id, async (tx) => {
      expect(await tx.notificationPreference.findMany({ where: { userAccountId: fixture.one.id } })).toEqual([]);
    });
    for (const data of [{ organizationId: other.id, userAccountId: fixture.one.id }, { organizationId: org.id, userAccountId: randomUUID() }]) {
      await expect(withTenant(prisma, other.id, (tx) => tx.notificationPreference.create({ data }))).rejects.toThrow();
    }
    for (const data of [{ inAppSecurity: false }, { emailSecurity: false }]) {
      await expect(withTenant(prisma, org.id, (tx) => tx.notificationPreference.updateMany({ where: { userAccountId: fixture.one.id }, data }))).rejects.toThrow();
    }
    await Promise.all([saveNotificationPreferences(actor, defaults, deps), saveNotificationPreferences(actor, { ...changed, in_app: { ...changed.in_app, operations: false } }, deps)]);
    const audits = await withTenant(prisma, org.id, (tx) => tx.auditLog.findMany({ where: { action: "notification.preferences.update", resourceId: fixture.one.id }, orderBy: { id: "asc" } }));
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({ actorId: fixture.one.id, before: { inApp: defaults.in_app, emailSecurity: true }, after: { inApp: changed.in_app, emailSecurity: true } });
    expect(audits[1].before).toEqual(audits[0].after);
    expect(audits[2].before).toEqual(audits[1].after);
    await withTenant(prisma, org.id, (tx) => tx.userAccount.update({ where: { id: fixture.one.id }, data: { status: "SUSPENDED" } }));
    await expect(getNotificationPreferences(actor, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(saveNotificationPreferences(actor, changed, deps)).rejects.toBeInstanceOf(NotificationAccessError);
  });

  it("applies category and channel preferences in the real delivery pipeline while preserving security and terminal suppression", async () => {
    const org = await prisma.organization.create({ data: { name: `Preference delivery ${randomUUID()}` } });
    const fixture = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Preference delivery" } });
      const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id, email: `preference-${randomUUID()}@example.test` } });
      const property = await tx.property.create({ data: { organizationId: org.id, name: "Preference villa", addressLine1: "Test", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const role = await tx.role.create({ data: { organizationId: org.id, key: "preference-worker", name: "Preference worker" } });
      const permission = await tx.permission.create({ data: { organizationId: org.id, key: "task:view", resource: "task", action: "view" } });
      await tx.rolePermission.create({ data: { organizationId: org.id, roleId: role.id, permissionId: permission.id } });
      await tx.roleAssignment.create({ data: { organizationId: org.id, personId: person.id, userAccountId: account.id, roleId: role.id, scopeType: "property", scopeId: property.id } });
      const task = await tx.operationTask.create({ data: { organizationId: org.id, propertyId: property.id, type: "CLEANING", state: "PLANNED", assignedToUserAccountId: account.id, dueDate: new Date(), titleTranslations: { en: "Test", fr: "Test" }, idempotencyKey: randomUUID() } });
      const session = await tx.authSession.create({ data: { organizationId: org.id, userAccountId: account.id, deviceId: "preference-test", sessionVersion: 1, expiresAt: new Date(Date.now() + 3600000) } });
      return { person, account, task, session };
    });
    const actor = { organizationId: org.id, accountId: fixture.account.id,
      authContext: ownNotificationContext({ organizationId: org.id, permissions: new Set<string>(), scopes: [] }, fixture.account.id) };
    const deps = { db: prisma as TenantTransactionRunner, requestId: randomUUID() };
    const defaults = defaultNotificationPreferences();
    const send = async (kind: "language_updated" | "task_assigned", key: string) => withTenant(prisma, org.id, (tx) => publishNotification(tx, org.id,
      { kind, recipientId: fixture.account.id, targetId: kind === "task_assigned" ? fixture.task.id : fixture.account.id }, key));
    await saveNotificationPreferences(actor, { ...defaults, in_app: { ...defaults.in_app, account: false } }, deps);
    await updateOwnPreferredLocale({ organizationId: org.id, actorId: actor.accountId, personId: fixture.person.id, authContext: actor.authContext }, "fr", deps);
    await send("task_assigned", "task-enabled");
    expect((await getNotificationPage(actor, {}, deps)).items.map((item) => item.kind)).toEqual(["task_assigned"]);
    await saveNotificationPreferences(actor, { ...defaults, in_app: { ...defaults.in_app, operations: false } }, deps);
    await send("task_assigned", "task-disabled");
    await send("language_updated", "account-enabled");
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(2);
    await saveNotificationPreferences(actor, { ...defaults, in_app: { ...defaults.in_app, enabled: false } }, deps);
    await send("language_updated", "channel-disabled");
    await send("task_assigned", "channel-disabled-task");
    const identityContext = { organizationId: org.id, actorId: actor.accountId, personId: fixture.person.id,
      authContext: { organizationId: org.id, permissions: new Set(["identity:override"]), scopes: [{ organizationId: org.id }] } };
    await revokeSession(identityContext, fixture.session.id, deps);
    const inbox = await getNotificationPage(actor, {}, deps);
    expect(inbox.unreadCount).toBe(3);
    const security = inbox.items.find((item) => item.kind === "security_session_revoked")!;
    expect(await openNotification(actor, security.id, "fr", deps)).toBe("/fr/app/security");
    const recoveryContext = { ...identityContext, authContext: { ...identityContext.authContext, permissions: new Set(["identity:edit"]) } };
    await issueRecoveryCode(recoveryContext, actor.accountId, deps);
    const sent: string[] = [];
    const handlers = createInngestOutboxHandlers({ APP_URL: "http://localhost:3000" }, undefined, {
      send: (input) => { sent.push(input.template); return Promise.resolve({ id: "postgres-test-transport" }); }
    });
    expect(await dispatchOutboxBatch(prisma, org.id, handlers)).toMatchObject({ dispatched: 1, failed: 0 });
    expect(sent).toEqual(["identity.recovery"]);
    await saveNotificationPreferences(actor, defaults, deps);
    const events = await withTenant(prisma, org.id, (tx) => tx.outboxEvent.findMany({ where: { organizationId: org.id, type: "notification.requested" } }));
    expect(events).toHaveLength(7);
    expect(events.every((event) => event.status === "DISPATCHED")).toBe(true);
    for (const event of events) await deliverNotificationEvent(event, deps);
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(3);
    await send("language_updated", "channel-disabled");
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(3);
  });

  it("persists recipient notifications, denies tenant and recipient access, and replays events without duplicate unread counts", async () => {
    const org = await prisma.organization.create({ data: { name: `Notification integration ${randomUUID()}` } });
    const foreignOrg = await prisma.organization.create({ data: { name: `Notification isolation ${randomUUID()}` } });
    const accounts = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Notification test" } });
      const one = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      const two = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      return { one, two, person };
    });
    const context = (accountId: string, organizationId = org.id) => ({ organizationId, accountId,
      authContext: ownNotificationContext({ organizationId, permissions: new Set<string>(), scopes: [{ organizationId }] }, accountId) });
    const actor = context(accounts.one.id);
    const deps = { db: prisma as TenantTransactionRunner, requestId: randomUUID() };
    // The actual business service, not a seeded notification, produces the first event.
    await updateOwnPreferredLocale({ organizationId: org.id, actorId: accounts.one.id, personId: accounts.person.id, authContext: actor.authContext }, "fr", deps);
    const first = await getNotificationPage(actor, {}, deps);
    expect(first.unreadCount).toBe(1);
    expect(first.items[0]).toMatchObject({ kind: "language_updated", readAt: null, available: true });
    expect(first.items[0]).not.toHaveProperty("targetId");
    const event = await withTenant(prisma, org.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: org.id, idempotencyKey: `notification:language:${accounts.one.id}:${deps.requestId}` } }));
    expect(event.status).toBe("DISPATCHED");
    await Promise.all([deliverNotificationEvent(event, deps), deliverNotificationEvent(event, deps)]);
    await createInngestOutboxHandlers({})[event.type](event);
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(1);
    expect((await getNotificationPage(context(accounts.two.id), {}, deps)).items).toEqual([]);
    const id = first.items[0].id;
    await expect(readNotification(context(accounts.two.id), id, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(openNotification(context(accounts.one.id, foreignOrg.id), id, "en", deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(readNotification({ ...actor, organizationId: foreignOrg.id }, id, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await withTenant(prisma, foreignOrg.id, async (tx) => {
      expect(await tx.notification.findMany({ where: { id } })).toEqual([]);
      await expect(tx.notification.create({ data: { organizationId: foreignOrg.id, recipientId: accounts.one.id, eventId: event.id, kind: "language_updated", targetId: accounts.one.id } })).rejects.toThrow();
    });
    await Promise.all([readNotification(actor, id, deps), readNotification(actor, id, deps)]);
    const read = await getNotificationPage(actor, {}, deps);
    expect(read.unreadCount).toBe(0);
    expect(read.items[0].readAt).not.toBeNull();
    expect(await openNotification(actor, id, "fr", deps)).toBe("/fr/app");
    await withTenant(prisma, org.id, async (tx) => {
      expect(await tx.auditLog.count({ where: { organizationId: org.id, action: "notification.read", resourceId: id } })).toBe(1);
    });
    await expect(withTenant(prisma, org.id, (tx) => tx.notification.update({ where: { id }, data: { readAt: null } }))).rejects.toThrow("first notification read timestamp");
    await expect(withTenant(prisma, org.id, (tx) => tx.notification.delete({ where: { id } }))).rejects.toThrow("append-only");
    // Many real events with identical times exercise the UUID keyset tie breaker.
    await withTenant(prisma, org.id, async (tx) => {
      for (let index = 0; index < 23; index += 1) await publishNotification(tx, org.id, { kind: "language_updated", recipientId: accounts.one.id, targetId: accounts.one.id }, `notification:pagination:${index}`);
    });
    const pageOne = await getNotificationPage(actor, {}, deps);
    const pageTwo = await getNotificationPage(actor, { cursor: pageOne.nextCursor }, deps);
    expect(pageOne.items).toHaveLength(20);
    expect(pageTwo.items).toHaveLength(4);
    expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)).size).toBe(24);
    expect(pageOne.unreadCount).toBe(23);
    const freshConnection = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } } });
    try {
      const persisted = await getNotificationPage(actor, {}, { db: freshConnection });
      expect(persisted).toEqual(pageOne);
    } finally { await freshConnection.$disconnect(); }
  });

  it("rechecks task record permissions after notification delivery and batches target authorization", async () => {
    const org = await prisma.organization.create({ data: { name: `Notification task ${randomUUID()}` } });
    const fixture = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Assigned worker" } });
      const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      const property = await tx.property.create({ data: { organizationId: org.id, name: "Test notification villa", addressLine1: "Test", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const role = await tx.role.create({ data: { organizationId: org.id, key: "notification-worker", name: "Assigned worker" } });
      const permission = await tx.permission.create({ data: { organizationId: org.id, key: "task:view", resource: "task", action: "view" } });
      await tx.rolePermission.create({ data: { organizationId: org.id, roleId: role.id, permissionId: permission.id } });
      await tx.roleAssignment.create({ data: { organizationId: org.id, personId: person.id, userAccountId: account.id, roleId: role.id, scopeType: "property", scopeId: property.id, conditions: { assignedToMe: true } } });
      const task = await tx.operationTask.create({ data: { organizationId: org.id, propertyId: property.id, assignedToUserAccountId: account.id,
        type: "ARRIVAL_PREPARATION", dueDate: new Date("2026-10-16"), titleTranslations: { en: "Private record title" }, idempotencyKey: randomUUID() } });
      await publishNotification(tx, org.id, { kind: "task_assigned", recipientId: account.id, targetId: task.id }, `notification:task:${task.id}`);
      for (let index = 0; index < 19; index += 1) {
        const another = await tx.operationTask.create({ data: { organizationId: org.id, propertyId: property.id, assignedToUserAccountId: account.id,
          type: "ARRIVAL_PREPARATION", dueDate: new Date("2026-10-16"), titleTranslations: { en: "Private record title" }, idempotencyKey: randomUUID() } });
        await publishNotification(tx, org.id, { kind: "task_assigned", recipientId: account.id, targetId: another.id }, `notification:task:${another.id}`);
      }
      return { account, property, task };
    });
    const actor = { organizationId: org.id, accountId: fixture.account.id, authContext: ownNotificationContext({ organizationId: org.id,
      permissions: new Set(["task:view"]), scopes: [{ organizationId: org.id, scopeType: "property" as const, scopeId: fixture.property.id }],
      assignments: [{ scope: { organizationId: org.id, scopeType: "property", scopeId: fixture.property.id }, permissions: new Set(["task:view"]), conditions: { assignedToMe: true } }] }, fixture.account.id) };
    const deps = { db: prisma as TenantTransactionRunner };
    const page = await getNotificationPage(actor, {}, deps);
    expect(page.items).toHaveLength(20);
    const item = page.items.at(-1)!;
    expect(page.items[0].available).toBe(true);
    const measured = new PrismaClient({ datasources: { db: { url: notificationTestDatabaseUrl } }, log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    measured.$on("query", (event) => { queries.push(event.query); });
    try {
      await getNotificationPage(actor, {}, { db: measured });
      expect(queries.filter((query) => query.startsWith("SELECT"))).toHaveLength(5);
    } finally { await measured.$disconnect(); }
    expect(await openNotification(actor, item.id, "en", deps)).toBe(`/en/app/field/${fixture.task.id}`);
    const denied = { ...actor, authContext: ownNotificationContext({ organizationId: org.id, permissions: new Set<string>(), scopes: [{ organizationId: org.id }] }, actor.accountId) };
    expect((await getNotificationPage(denied, {}, deps)).items[0].available).toBe(false);
    await expect(openNotification(denied, item.id, "en", deps)).rejects.toBeInstanceOf(NotificationAccessError);
    await withTenant(prisma, org.id, (tx) => tx.operationTask.update({ where: { id: fixture.task.id }, data: { assignedToUserAccountId: null } }));
    await expect(openNotification(actor, item.id, "en", deps)).rejects.toBeInstanceOf(NotificationAccessError);
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(20);
    await readNotification(actor, item.id, deps);
    expect((await getNotificationPage(actor, {}, deps)).unreadCount).toBe(19);
  });

  it("routes events by effective property configuration with scoped roles, people, preferences, terminal replay and mandatory security", async () => {
    const runner = prisma as TenantTransactionRunner;
    const org = await prisma.organization.create({ data: { name: "Routing tenant" } });
    const other = await prisma.organization.create({ data: { name: "Other routing tenant" } });
    const fixture = await withTenant(runner, org.id, async (tx) => {
      const propertyData = { organizationId: org.id, addressLine1: "Test", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] };
      const property = await tx.property.create({ data: { ...propertyData, name: "Routing villa" } });
      const second = await tx.property.create({ data: { ...propertyData, name: "Other routing villa" } });
      const role = await tx.role.create({ data: { organizationId: org.id, key: "routing-custom", name: "Routing custom role" } });
      const broad = await tx.role.create({ data: { organizationId: org.id, key: "routing-broad", name: "Unselected broad role" } });
      const permission = await tx.permission.create({ data: { organizationId: org.id, key: "task:view", resource: "task", action: "view" } });
      for (const roleId of [role.id, broad.id]) await tx.rolePermission.create({ data: { organizationId: org.id, roleId, permissionId: permission.id } });
      const accounts = [];
      for (const name of ["assigned", "selected", "wrong-scope", "disabled", "expired", "inactive"]) {
        const person = await tx.person.create({ data: { organizationId: org.id, displayName: name } });
        const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id, status: name === "inactive" ? "SUSPENDED" : "ACTIVE" } });
        await tx.roleAssignment.create({ data: { organizationId: org.id, personId: person.id, userAccountId: account.id, roleId: role.id,
          scopeType: "property", scopeId: name === "wrong-scope" ? second.id : property.id,
          validFrom: new Date("2020-01-01"), validTo: name === "expired" ? new Date("2020-01-02") : null } });
        if (name === "wrong-scope") await tx.roleAssignment.create({ data: { organizationId: org.id, personId: person.id, userAccountId: account.id, roleId: broad.id, scopeType: "organization" } });
        if (name === "disabled") await tx.notificationPreference.create({ data: { organizationId: org.id, userAccountId: account.id, inAppOperations: false } });
        accounts.push(account);
      }
      const task = await tx.operationTask.create({ data: { organizationId: org.id, propertyId: property.id, assignedToUserAccountId: accounts[0].id,
        type: "INSPECTION", dueDate: new Date("2026-10-16"), titleTranslations: { en: "Real routing record" }, idempotencyKey: randomUUID() } });
      return { property, second, role, task, accounts };
    });
    const [assigned, selected, wrongScope, disabled, expired, inactive] = fixture.accounts;
    const admin = { organizationId: org.id, accountId: assigned.id, authContext: { organizationId: org.id, userAccountId: assigned.id, personId: assigned.personId,
      permissions: new Set(["config_rule:configure", "config_rule:view"]), scopes: [{ organizationId: org.id }] } };
    const deps = { db: runner, requestId: "routing-configuration" };
    const routing: NotificationRouting = { roles: [fixture.role.id], people: [selected.personId], assigned: true, channels: ["in_app"] };
    const kind = "task_assigned" as const;
    await saveNotificationRouting(admin, { kind, propertyId: null, routing: { ...routing, channels: [] }, reason: "Disable organization delivery" }, deps);
    await saveNotificationRouting(admin, { kind, propertyId: fixture.property.id, routing, reason: "Property team receives assignments" }, deps);
    expect((await getNotificationRouting(admin, { kind, propertyId: fixture.property.id }, deps)).routing).toEqual(routing);
    await withTenant(runner, org.id, async (tx) => {
      const repo = new ConfigRuleRepository(tx, org.id);
      await repo.createVersion({ key: notificationRoutingKey(kind), scopeType: "property", scopeId: fixture.property.id,
        value: { ...routing, channels: [] }, effectiveFrom: new Date(Date.now() + 3600000), reason: "Future configuration must not win yet" });
      await publishNotification(tx, org.id, { kind, recipientId: assigned.id, targetId: fixture.task.id }, "routing-real-assignment");
    });
    const event = await withTenant(runner, org.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: org.id, idempotencyKey: "routing-real-assignment" } }));
    const recipients = await withTenant(runner, org.id, (tx) => tx.notification.findMany({ where: { eventId: event.id } }));
    expect(recipients.map((row) => row.recipientId).sort()).toEqual([assigned.id, selected.id].sort());
    for (const denied of [wrongScope, disabled, expired, inactive]) expect(recipients.map((row) => row.recipientId)).not.toContain(denied.id);
    // A stale payload cannot change the terminal selection after scope/preferences/config change.
    await saveNotificationRouting(admin, { kind, propertyId: fixture.property.id, routing: { ...routing, people: [wrongScope.personId, disabled.personId] }, reason: "Change future notification recipients" }, deps);
    await Promise.all(Array.from({ length: 3 }, () => deliverNotificationEvent({ ...event, status: "PENDING" }, deps)));
    expect(await withTenant(runner, org.id, (tx) => tx.notification.count({ where: { eventId: event.id } }))).toBe(2);
    const foreignPerson = await withTenant(runner, other.id, (tx) => tx.person.create({ data: { organizationId: other.id, displayName: "Foreign person" } }));
    for (const forbidden of [{ ...admin, accountId: selected.id }, { ...admin, organizationId: other.id }, { ...admin, authContext: { ...admin.authContext, permissions: new Set<string>() } },
      { ...admin, authContext: { ...admin.authContext, scopes: [{ organizationId: org.id, scopeType: "property" as const, scopeId: fixture.second.id }] } }]) {
      await expect(saveNotificationRouting(forbidden, { kind, propertyId: fixture.property.id, routing, reason: "Forbidden routing change" }, deps)).rejects.toBeInstanceOf(NotificationAccessError);
      await expect(getNotificationRouting(forbidden, { kind, propertyId: fixture.property.id }, deps)).rejects.toBeInstanceOf(NotificationAccessError);
    }
    await expect(saveNotificationRouting(admin, { kind, propertyId: null, routing: { ...routing, people: [foreignPerson.id] }, reason: "Foreign recipient denied" }, deps)).rejects.toThrow("Invalid routing references");
    await expect(withTenant(runner, other.id, (tx) => new NotificationRepository(tx, org.id).publish({ kind, recipientId: assigned.id, targetId: fixture.task.id }, "cross-tenant-routing"))).rejects.toThrow(/row-level security/u);
    await saveNotificationRouting(admin, { kind: "task_completed", propertyId: fixture.property.id, routing: { ...routing, channels: [] }, reason: "Disable completion delivery channel" }, deps);
    await withTenant(runner, org.id, async (tx) => {
      await tx.notificationPreference.create({ data: { organizationId: org.id, userAccountId: assigned.id, inAppEnabled: false } });
      await new ConfigRuleRepository(tx, org.id).createVersion({ key: notificationRoutingKey("security_session_revoked"), scopeType: "organization",
        value: { roles: [], people: [], assigned: false, channels: [] }, effectiveFrom: new Date(0), reason: "Security routing cannot opt out" });
      await publishNotification(tx, org.id, { kind: "security_session_revoked", recipientId: assigned.id, targetId: assigned.id }, "routing-mandatory-security");
      expect(await tx.notification.count({ where: { recipientId: assigned.id, kind: "security_session_revoked" } })).toBe(1);
      await publishNotification(tx, org.id, { kind: "task_completed", recipientId: assigned.id, targetId: fixture.task.id }, "routing-disabled-event");
    });
    const suppressed = await withTenant(runner, org.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { idempotencyKey: "routing-disabled-event" } }));
    await saveNotificationRouting(admin, { kind: "task_completed", propertyId: fixture.property.id, routing, reason: "Enable subsequent completions" }, deps);
    await deliverNotificationEvent({ ...suppressed, status: "PENDING" }, deps);
    expect(await withTenant(runner, org.id, (tx) => tx.notification.count({ where: { eventId: suppressed.id } }))).toBe(0);
    expect(await withTenant(runner, org.id, (tx) => tx.auditLog.count({ where: { action: "config_rule.version.created", requestId: deps.requestId } }))).toBe(5);
  });

  it("rolls routing decisions back on failure and delivers concurrent pending events once", async () => {
    const org = await prisma.organization.create({ data: { name: "Routing retries" } });
    const fixture = await withTenant(prisma, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Routing retry person" } });
      const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } });
      const event = await tx.outboxEvent.create({ data: { organizationId: org.id, type: "notification.requested", payload: { kind: "language_updated", recipientId: account.id, targetId: account.id }, idempotencyKey: "routing-retry" } });
      return { account, event };
    });
    await expect(withTenant(prisma, org.id, async (tx) => { await new NotificationRepository(tx, org.id).deliver(fixture.event); throw new Error("Transactional failure"); })).rejects.toThrow("Transactional failure");
    expect(await withTenant(prisma, org.id, (tx) => tx.notification.count())).toBe(0);
    await Promise.all(Array.from({ length: 4 }, () => deliverNotificationEvent(fixture.event, { db: prisma })));
    expect(await withTenant(prisma, org.id, (tx) => tx.notification.count())).toBe(1);
    expect((await withTenant(prisma, org.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { id: fixture.event.id } }))).status).toBe("DISPATCHED");
  });

  it("produces real approval events once, selects configured scoped approvers and resolves notifications on approval or rejection", async () => {
    const org = await prisma.organization.create({ data: { name: "Approval routing" } });
    const runner = prisma as TenantTransactionRunner;
    const fixture = await withTenant(runner, org.id, async (tx) => {
      const propertyData = { organizationId: org.id, addressLine1: "Approval road", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] };
      const property = await tx.property.create({ data: { ...propertyData, name: "Approval villa" } });
      const second = await tx.property.create({ data: { ...propertyData, name: "Other approval villa" } });
      const role = await tx.role.create({ data: { organizationId: org.id, key: "approval-custom", name: "Configured approvers" } });
      const broad = await tx.role.create({ data: { organizationId: org.id, key: "approval-broad", name: "Unselected wider role" } });
      const keys = ["property:view", "property:edit", "property:approve", "property:reject", "config_rule:view", "config_rule:configure"];
      for (const key of keys) {
        const [resource, action] = key.split(":");
        const permission = await tx.permission.create({ data: { organizationId: org.id, key, resource, action } });
        for (const roleId of [role.id, broad.id]) await tx.rolePermission.create({ data: { organizationId: org.id, roleId, permissionId: permission.id } });
      }
      const accounts = [];
      for (const name of ["requester", "approver", "wrong-scope", "opted-out", "unselected"]) {
        const person = await tx.person.create({ data: { organizationId: org.id, displayName: name, preferredLocale: "fr" } });
        const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id, email: `${name}@example.test` } });
        await tx.roleAssignment.create({ data: { organizationId: org.id, roleId: name === "unselected" || name === "requester" ? broad.id : role.id, personId: person.id, userAccountId: account.id,
          scopeType: "property", scopeId: name === "wrong-scope" ? second.id : property.id } });
        if (name === "wrong-scope") await tx.roleAssignment.create({ data: { organizationId: org.id, roleId: broad.id, personId: person.id, userAccountId: account.id, scopeType: "organization" } });
        if (name === "opted-out") await tx.notificationPreference.create({ data: { organizationId: org.id, userAccountId: account.id, inAppOperations: false } });
        accounts.push(account);
      }
      return { property, second, role, accounts, keys };
    });
    const [requester, approver, wrongScope, optedOut, unselected] = fixture.accounts;
    function actor(account: typeof requester) {
      return { organizationId: org.id, accountId: account.id, authContext: ownNotificationContext({ organizationId: org.id, userAccountId: account.id, personId: account.personId,
        permissions: new Set(fixture.keys), scopes: [{ organizationId: org.id, scopeType: "property" as const, scopeId: fixture.property.id }] }, account.id) };
    }
    const admin = { ...actor(requester), authContext: { ...actor(requester).authContext, assignments: undefined, scopes: [{ organizationId: org.id }] } };
    const deps = { db: runner, requestId: "approval-routing" };
    await saveNotificationRouting(admin, { kind: "approval_requested", propertyId: fixture.property.id, routing: { roles: [fixture.role.id], people: [], assigned: false, channels: ["in_app"] }, reason: "Configure scoped approval recipients" }, deps);
    const input = { propertyId: fixture.property.id, title: "Approve inspection schedule", details: "Review the requested inspection schedule", idempotencyKey: randomUUID() };
    const requests = await Promise.all(Array.from({ length: 4 }, () => requestApproval(actor(requester), input, deps)));
    expect(new Set(requests.map((row) => row.id)).size).toBe(1);
    const id = requests[0].id;
    const events = await withTenant(runner, org.id, (tx) => tx.outboxEvent.findMany({ where: { idempotencyKey: `approval:${id}:requested` } }));
    expect(events).toHaveLength(1);
    const rows = await withTenant(runner, org.id, (tx) => tx.notification.findMany({ where: { targetId: id } }));
    expect(rows.map((row) => row.recipientId)).toEqual([approver.id]);
    const rollbackKey = randomUUID();
    const rollbackRunner: TenantTransactionRunner = { $transaction: (work, options) => runner.$transaction(async (tx) => { await work(tx); throw new Error("Forced approval rollback"); }, options) };
    await expect(requestApproval(actor(requester), { ...input, idempotencyKey: rollbackKey }, { db: rollbackRunner })).rejects.toThrow("Forced approval rollback");
    expect(await withTenant(runner, org.id, (tx) => tx.approvalRequest.count({ where: { idempotencyKey: rollbackKey } }))).toBe(0);
    expect(await withTenant(runner, org.id, (tx) => tx.auditLog.count({ where: { action: "approval.requested" } }))).toBe(1);
    expect((await withTenant(runner, org.id, (tx) => tx.approvalRecipient.findMany({ where: { approvalId: id } }))).map((row) => row.userAccountId).sort()).toEqual([approver.id, optedOut.id].sort());
    await Promise.all(Array.from({ length: 3 }, () => deliverNotificationEvent({ ...events[0], status: "PENDING" }, deps)));
    expect(await withTenant(runner, org.id, (tx) => tx.notification.count({ where: { targetId: id } }))).toBe(1);
    expect(await openNotification(actor(approver), rows[0].id, "fr", deps)).toBe(`/fr/app/approvals/${id}`);
    for (const account of [wrongScope, unselected, requester]) await expect(decideApproval(actor(account), { id, decision: "APPROVED", reason: "Unauthorized decision attempt" }, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    const deniedScope = { ...actor(approver), authContext: ownNotificationContext({ ...actor(approver).authContext, assignments: undefined, scopes: [{ organizationId: org.id, scopeType: "property", scopeId: fixture.second.id }] }, approver.id) };
    await expect(getApproval(deniedScope, id, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(decideApproval(deniedScope, { id, decision: "APPROVED", reason: "Wrong property scope denied" }, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    const deniedPermission = { ...actor(approver), authContext: { ...actor(approver).authContext, permissions: new Set(["property:view", "notification:view"]) } };
    await expect(decideApproval(deniedPermission, { id, decision: "APPROVED", reason: "Missing decision permission denied" }, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    await readNotification(actor(approver), rows[0].id, deps);
    const readAt = (await withTenant(runner, org.id, (tx) => tx.notification.findFirstOrThrow({ where: { id: rows[0].id } }))).readAt;
    const decision = { id, decision: "APPROVED", reason: "Inspection schedule reviewed and accepted" };
    await Promise.all(Array.from({ length: 3 }, () => decideApproval(actor(approver), decision, deps)));
    expect((await getApproval(actor(approver), id, deps)).state).toBe("APPROVED");
    expect(await withTenant(runner, org.id, (tx) => tx.outboxEvent.count({ where: { idempotencyKey: `approval:${id}:decided` } }))).toBe(1);
    expect(await withTenant(runner, org.id, (tx) => tx.notification.count({ where: { targetId: id, recipientId: requester.id, kind: "approval_decided" } }))).toBe(1);
    expect(await withTenant(runner, org.id, (tx) => tx.notification.findFirstOrThrow({ where: { id: rows[0].id } }))).toMatchObject({ resolution: "APPROVED", readAt, resolvedAt: expect.any(Date) as Date });
    await expect(decideApproval(actor(approver), { ...decision, decision: "REJECTED" }, deps)).rejects.toBeInstanceOf(ApprovalConflictError);
    expect(await withTenant(runner, org.id, (tx) => tx.auditLog.count({ where: { action: "approval.approved", resourceId: id } }))).toBe(1);
    const rejected = await requestApproval(actor(requester), { ...input, idempotencyKey: randomUUID() }, deps);
    await decideApproval(actor(approver), { id: rejected.id, decision: "REJECTED", reason: "Please propose another inspection date" }, deps);
    expect(await withTenant(runner, org.id, (tx) => tx.notification.findFirstOrThrow({ where: { targetId: rejected.id, kind: "approval_requested" } }))).toMatchObject({ resolution: "REJECTED", readAt: expect.any(Date) as Date });
    const foreign = await prisma.organization.create({ data: { name: "Foreign approval tenant" } });
    const foreignActor = { ...actor(approver), organizationId: foreign.id, authContext: { ...actor(approver).authContext, organizationId: foreign.id } };
    await expect(getApproval(foreignActor, id, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(decideApproval(foreignActor, decision, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(requestApproval(foreignActor, { ...input, idempotencyKey: randomUUID() }, deps)).rejects.toBeInstanceOf(ApprovalAccessError);
    expect(await withTenant(runner, foreign.id, (tx) => tx.approvalRequest.count())).toBe(0);
    await expect(withTenant(runner, foreign.id, (tx) => tx.approvalRecipient.create({ data: { organizationId: foreign.id, approvalId: id, userAccountId: approver.id } }))).rejects.toThrow();
    await expect(withTenant(runner, org.id, (tx) => tx.approvalRequest.delete({ where: { id } }))).rejects.toThrow(/cannot be deleted/u);
  });

  it("validates durable Inngest dispatch references against real tenant isolation", async () => {
    const first = await prisma.organization.create({ data: { name: "Inngest first tenant" } });
    const second = await prisma.organization.create({ data: { name: "Inngest second tenant" } });
    const event = await withTenant(prisma, first.id, tx => new OutboxRepository(tx, first.id).requestDispatch("same-key"));
    expect((await withTenant(prisma, first.id, tx => new OutboxRepository(tx, first.id).requestDispatch("same-key"))).id).toBe(event.id);
    await expect(dispatchRequestOrganization({ organizationId: first.id, outboxEventId: event.id }, prisma)).resolves.toBe(first.id);
    await expect(dispatchRequestOrganization({ organizationId: second.id, outboxEventId: event.id }, prisma)).rejects.toThrow("outbox_dispatch_reference_denied");
    expect(await withTenant(prisma, second.id, tx => tx.outboxEvent.count())).toBe(0);
  });

  it("serializes independent outbox drains and forwards tenant-safe idempotent references once", async () => {
    const first = await prisma.organization.create({ data: { name: "Inngest concurrent first" } });
    const second = await prisma.organization.create({ data: { name: "Inngest concurrent second" } });
    const event = await withTenant(prisma, first.id, tx => new OutboxRepository(tx, first.id).requestDispatch("same-key"));
    const other = await withTenant(prisma, second.id, tx => new OutboxRepository(tx, second.id).requestDispatch("same-key"));
    const received: Array<{ id: string; data: unknown }> = [];
    const transport: InngestTransport = async (_url, input) => {
      received.push(JSON.parse(input.body) as { id: string; data: unknown }); await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: true, status: 200, json: () => Promise.resolve({ ids: ["accepted"], status: 200 }), text: () => Promise.resolve("") };
    };
    const handlers = { "*": async (row: typeof event) => { await createInngestOutboxHandler({ INNGEST_EVENT_KEY: "isolated-test" }, transport)(row); } };
    const results = await Promise.all(Array.from({ length: 3 }, () => dispatchOutboxBatch(prisma, first.id, handlers)));
    expect(results.reduce((count, result) => count + result.dispatched, 0)).toBe(1);
    expect(received).toHaveLength(1); expect(received[0].data).toEqual({ organizationId: first.id, outboxEventId: event.id });
    expect(await withTenant(prisma, second.id, tx => new OutboxRepository(tx, second.id).event(other.id))).toMatchObject({ status: "PENDING", attemptCount: 0 });
    await dispatchOutboxBatch(prisma, second.id, handlers);
    expect(received).toHaveLength(2); expect(received[0].id).not.toBe(received[1].id);
  });

  it("persists malformed Inngest acknowledgements for retry without secrets and retains the same event id", async () => {
    const org = await prisma.organization.create({ data: { name: "Inngest acknowledgement retries" } });
    const event = await withTenant(prisma, org.id, tx => new OutboxRepository(tx, org.id).requestDispatch("ack-retry"));
    let valid = false; const ids: string[] = [];
    const transport: InngestTransport = (_url, input) => { ids.push((JSON.parse(input.body) as { id: string }).id); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ids: valid ? ["accepted"] : [], status: 200 }), text: () => Promise.resolve("") }); };
    const handlers = { "*": async (row: typeof event) => { await createInngestOutboxHandler({ INNGEST_EVENT_KEY: "isolated-secret" }, transport)(row); } };
    const now = new Date();
    expect(await dispatchOutboxBatch(prisma, org.id, handlers, { now, errorReporter: async () => {} })).toMatchObject({ failed: 1 });
    const failed = await withTenant(prisma, org.id, tx => new OutboxRepository(tx, org.id).event(event.id));
    expect(failed).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "Inngest event response did not acknowledge delivery", nextAttemptAt: expect.any(Date) as Date });
    valid = true;
    expect(await dispatchOutboxBatch(prisma, org.id, handlers, { now })).toMatchObject({ dispatched: 0 });
    expect(await dispatchOutboxBatch(prisma, org.id, handlers, { now: failed!.nextAttemptAt! })).toMatchObject({ dispatched: 1 });
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  });

  it("routes external channels through provider interfaces with durable retries, replay suppression and consent rechecks", async () => {
    const org = await prisma.organization.create({ data: { name: "External notification retries" } });
    const runner = prisma as TenantTransactionRunner;
    const fixture = await withTenant(runner, org.id, async (tx) => {
      const person = await tx.person.create({ data: { organizationId: org.id, displayName: "Consenting recipient", preferredLocale: "fr" } });
      const account = await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id, email: "consenting@example.test" } });
      await tx.notificationPreference.create({ data: { organizationId: org.id, userAccountId: account.id, emailEnabled: true, emailAccount: true, pushEnabled: true, pushAccount: true } });
      await new ConfigRuleRepository(tx, org.id).createVersion({ key: "notification.routing.language_updated", scopeType: "organization", effectiveFrom: new Date(0), value: { roles: [], people: [], assigned: true, channels: ["in_app", "email", "push"] }, reason: "Enable consented external channels" });
      await publishNotification(tx, org.id, { kind: "language_updated", targetId: account.id, recipientId: account.id }, "external-real-source");
      return { account };
    });
    let fail = true; const calls: Array<{ channel: string; key?: string; locale?: string }> = [];
    const channels = Object.fromEntries((["email", "push"] as const).map((channel) => [channel, { notify: (input: { idempotencyKey?: string; locale?: string }) => {
      calls.push({ channel, key: input.idempotencyKey, locale: input.locale });
      if (fail && channel === "email") return Promise.reject(new Error("private transport detail must be redacted"));
      return Promise.resolve({ id: "test-provider-acknowledgement" });
    } }]));
    const handler = (event: Parameters<typeof deliverNotificationChannel>[0]) => deliverNotificationChannel(event, { db: runner, channels, appUrl: "https://staging.example.test" });
    const handlers = { [notificationChannelEventType]: handler };
    const now = new Date();
    expect(await dispatchOutboxBatch(runner, org.id, handlers, { now, errorReporter: async () => {} })).toMatchObject({ failed: 1, dispatched: 1 });
    const failed = await withTenant(runner, org.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { status: "PENDING" } }));
    expect(failed).toMatchObject({ attemptCount: 1, lastError: "Notification email provider did not acknowledge delivery", nextAttemptAt: expect.any(Date) as Date });
    expect(await dispatchOutboxBatch(runner, org.id, handlers, { now, errorReporter: async () => {} })).toMatchObject({ failed: 0, dispatched: 0 });
    fail = false;
    expect(await dispatchOutboxBatch(runner, org.id, handlers, { now: failed.nextAttemptAt!, errorReporter: async () => {} })).toMatchObject({ failed: 0, dispatched: 1 });
    await Promise.all(Array.from({ length: 3 }, () => handler(failed)));
    expect(calls.filter((call) => call.channel === "email")).toHaveLength(2);
    expect(new Set(calls.filter((call) => call.channel === "email").map((call) => call.key)).size).toBe(1);
    expect(calls.every((call) => call.locale === "fr")).toBe(true);
    await withTenant(runner, org.id, async (tx) => {
      await publishNotification(tx, org.id, { kind: "language_updated", targetId: fixture.account.id, recipientId: fixture.account.id }, "external-consent-revoked");
    });
    const unconfigured = await withTenant(runner, org.id, (tx) => tx.outboxEvent.findMany({ where: { type: notificationChannelEventType, status: "PENDING" } }));
    expect(unconfigured).toHaveLength(2);
    for (const event of unconfigured) await expect(deliverNotificationChannel(event, { db: runner, channels: {}, appUrl: "https://staging.example.test" })).rejects.toThrow(/provider is not configured/u);
    await withTenant(runner, org.id, (tx) => tx.notificationPreference.updateMany({ where: { userAccountId: fixture.account.id }, data: { emailEnabled: false, pushEnabled: false } }));
    const before = calls.length;
    expect(await dispatchOutboxBatch(runner, org.id, handlers, { errorReporter: async () => {} })).toMatchObject({ failed: 0, dispatched: 2 });
    expect(calls).toHaveLength(before);
  });

  it("resolves a concurrently initialized routing rule for every independent source event", async () => {
    const org = await prisma.organization.create({ data: { name: "Concurrent first routing use" } });
    const accounts = await withTenant(prisma, org.id, async (tx) => {
      const result = [];
      for (let index = 0; index < 4; index += 1) {
        const person = await tx.person.create({ data: { organizationId: org.id, displayName: `Concurrent recipient ${index}` } });
        result.push(await tx.userAccount.create({ data: { organizationId: org.id, personId: person.id } }));
      }
      return result;
    });
    await Promise.all(accounts.map((account) => withTenant(prisma, org.id, (tx) => publishNotification(tx, org.id, { kind: "language_updated", recipientId: account.id, targetId: account.id }, `concurrent-initial:${account.id}`))));
    expect(await withTenant(prisma, org.id, (tx) => tx.notification.count())).toBe(4);
    expect(await withTenant(prisma, org.id, (tx) => tx.configRule.count({ where: { key: "notification.routing.language_updated" } }))).toBe(1);
  });

  it("applies all migrations against an empty PostgreSQL database", async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations"
      ORDER BY migration_name
    `;

    expect(rows.map((row) => row.migration_name)).toEqual(migrationNames());
  });

  it("dispatches localized invitation emails and persists redacted provider retries in PostgreSQL", async () => {
    if (!adminPrisma) throw new Error("Expected local administrator connection");
    const email = `delivery-admin-${randomUUID()}@example.test`;
    const password = "local delivery integration password";
    const runner = prisma as unknown as TenantTransactionRunner;
    await bootstrapFirstAdmin(adminPrisma, { ADMIN_EMAIL: email, ADMIN_PASSWORD: password });
    const first = await authenticatePassword({ email, password, deviceId: "delivery-integration-device", headers: new Headers() });
    if (!first) throw new Error("Expected verified first-factor setup");
    const setup = await identityActorContextFromSession({ user: { ...first, sessionRevoked: false }, expires: new Date(Date.now() + 3600000).toISOString() }, { db: runner });
    if (!setup) throw new Error("Expected own-factor setup context");
    const authenticator = new IntegrationAuthenticator();
    const origin = "https://staging.example.test";
    const registration = await beginPasskeyRegistration(setup, { db: runner, origin });
    await finishPasskeyRegistration(setup, registration.challengeId, authenticator.registration(registration.options, origin), { db: runner, origin });
    const totp = await startTotpEnrollment(setup, { db: runner });
    await confirmTotpEnrollment(setup, totp.credentialId, totpCode(totp.secret), { db: runner });
    const authenticated = await authenticatePassword({ email, password, mfaCode: totpCode(totp.secret), deviceId: "delivery-integration-device", headers: new Headers() });
    if (!authenticated || authenticated.securitySetupRequired) throw new Error("Expected real MFA before requesting delivery");
    const ctx = await identityActorContextFromSession({ user: { ...authenticated, sessionRevoked: false }, expires: new Date(Date.now() + 3600000).toISOString() }, { db: runner });
    if (!ctx) throw new Error("Expected the authenticated delivery actor");
    const organization = { id: authenticated.organizationId };
    const invitation = await createInvitation(ctx, { displayName: "French recipient", email: `delivery-recipient-${randomUUID()}@example.test`,
      roleKey: "field_staff", scopeType: "organization", preferredLocale: "fr", expiresInHours: 24 }, { db: runner, origin: "https://staging.example.test" });
    const requests: Parameters<HttpTransport>[1][] = [];
    const transport: HttpTransport = (_url, request) => {
      requests.push(request);
      const ok = requests.length > 1;
      return Promise.resolve({ ok, status: ok ? 200 : 429, json: () => Promise.resolve({ id: "contract-email-id" }),
        text: () => Promise.resolve('private-recipient@example.test private-recovery-code'), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    };
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "transport-contract-key", EMAIL_FROM: "ops@example.test" }, transport);
    const handlers = createInngestOutboxHandlers({ INNGEST_EVENT_KEY: "transport-contract-event-key", APP_URL: "https://staging.example.test" }, undefined, provider);
    const now = new Date();
    const rejected = await dispatchOutboxBatch(runner, organization.id, handlers, { now, errorReporter: () => Promise.resolve() });
    expect(rejected).toEqual({ dispatched: 0, failed: 1, skipped: 0 });
    const failed = await withTenant(runner, organization.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { idempotencyKey: `identity.invitation.delivery:${invitation.invitationId}` } }));
    expect(failed).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "Resend email request failed with status 429" });
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await dispatchOutboxBatch(runner, organization.id, handlers, { now, errorReporter: () => Promise.resolve() })).toEqual({ dispatched: 0, failed: 0, skipped: 0 });
    expect(await dispatchOutboxBatch(runner, organization.id, handlers, { now: failed.nextAttemptAt!, errorReporter: () => Promise.resolve() })).toEqual({ dispatched: 1, failed: 0, skipped: 0 });
    expect(requests[0]?.headers?.["Idempotency-Key"]).toBe(requests[1]?.headers?.["Idempotency-Key"]);
    const sent: unknown = JSON.parse(requests[1].body!);
    expect(sent).toMatchObject({ subject: "Votre invitation ALVILLAS OS", html: expect.stringContaining(`https://staging.example.test/fr/activate/${invitation.code}`) as unknown });
    const delivered = await withTenant(runner, organization.id, (tx) => tx.outboxEvent.findFirstOrThrow({ where: { id: failed.id } }));
    expect(requests).toHaveLength(2);
    expect(delivered).toMatchObject({ status: "DISPATCHED", attemptCount: 1, lastError: null });
    expect(delivered.processedAt).not.toBeNull();
  });

  it("persists configurable PIN backoff across concurrent transactions and isolates tenant state", async () => {
    const orgA = await prisma.organization.create({ data: { name: "PIN security tenant", baseCurrency: "MAD" } });
    const orgB = await prisma.organization.create({ data: { name: "Other PIN security tenant", baseCurrency: "MAD" } });
    const runner = prisma as unknown as TenantTransactionRunner;
    const phone = "+212699000001";
    const now = new Date();
    await withTenant(runner, orgA.id, async (tx) => {
      await new ConfigRuleRepository(tx, orgA.id).createVersion({ key: pinLockoutConfigKey, scopeType: "organization",
        value: { attempts: 3, initialDelaySeconds: 10, maximumDelaySeconds: 40, resetAfterSeconds: 3600 },
        effectiveFrom: new Date(now.getTime() - 1000), reason: "Integration PIN security policy" });
    });
    await Promise.all(Array.from({ length: 4 }, () => withTenant(runner, orgA.id, async (tx) => {
      const repo = new PinSecurityRepository(tx, orgA.id);
      await repo.lock(phone);
      const state = await repo.state(phone);
      await repo.save(phone, (state?.count ?? 0) + 1, now);
    })));
    await withTenant(runner, orgA.id, async (tx) => {
      const repo = new PinSecurityRepository(tx, orgA.id);
      const state = await repo.state(phone);
      const policy = await repo.policy(now);
      expect(state?.count).toBe(4);
      expect(pinLockoutState(state, policy, now).lockedUntil.getTime() - now.getTime()).toBe(20_000);
      const stored = await tx.rateLimitBucket.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0].keyHash).not.toContain(phone);
      await repo.save(phone, 0, now);
      expect(pinLockoutState(await repo.state(phone), policy, now).locked).toBe(false);
    });
    await withTenant(runner, orgB.id, async (tx) => {
      expect(await new PinSecurityRepository(tx, orgB.id).state(phone)).toBeNull();
      const wrongTenantRepo = new PinSecurityRepository(tx, orgA.id);
      expect(await wrongTenantRepo.state(phone)).toBeNull();
      await expect(wrongTenantRepo.save(phone, 1, now)).rejects.toThrow(/row-level security/u);
    });
  });

  it("consumes invitation and recovery codes once under concurrency and prevents offboard recovery", async () => {
    if (!adminPrisma) throw new Error("Expected local administrator connection");
    const email = `idn-bootstrap-${randomUUID()}@example.test`;
    await bootstrapFirstAdmin(adminPrisma, { ADMIN_EMAIL: email, ADMIN_PASSWORD: "local integration bootstrap password" });
    const runner = prisma as unknown as TenantTransactionRunner;
    const admin = await withTenant(runner, bootstrapOrganizationId, (tx) => tx.userAccount.findFirstOrThrow({ where: { email } }));
    const credentialBefore = await withTenant(runner, bootstrapOrganizationId, async (tx) => {
      await tx.person.update({ where: { id: admin.personId }, data: { displayName: "Owner-managed profile" } });
      return tx.authCredential.findFirstOrThrow({ where: { userAccountId: admin.id, type: "PASSWORD" } });
    });
    const firstFactor = await authenticatePassword({ email, password: "local integration bootstrap password", deviceId: "integration-enrollment-device", headers: new Headers() });
    if (!firstFactor) throw new Error("Expected a real verified first factor");
    expect(firstFactor.securitySetupRequired).toBe(true);
    const setup = await identityActorContextFromSession({ user: { ...firstFactor, sessionRevoked: false }, expires: new Date(Date.now() + 3600000).toISOString() }, { db: runner });
    if (!setup) throw new Error("Expected authenticated own-factor setup");
    expect(setup.authContext.permissions.has("identity:create")).toBe(false);
    await expect(createInvitation(setup, { displayName: "Denied during setup", roleKey: "field_staff", scopeType: "organization", expiresInHours: 1 }, { db: runner })).rejects.toThrow(IdentityAuthorizationError);
    const authenticator = new IntegrationAuthenticator();
    const origin = "https://staging.example.test";
    const registration = await beginPasskeyRegistration(setup, { db: runner, origin });
    await finishPasskeyRegistration(setup, registration.challengeId, authenticator.registration(registration.options, origin), { db: runner, origin });
    const totp = await startTotpEnrollment(setup, { db: runner });
    await confirmTotpEnrollment(setup, totp.credentialId, totpCode(totp.secret), { db: runner });
    const enrolled = await withTenant(runner, bootstrapOrganizationId, (tx) => tx.authCredential.findFirstOrThrow({ where: { id: totp.credentialId } }));
    await bootstrapFirstAdmin(adminPrisma, { ADMIN_EMAIL: email, ADMIN_PASSWORD: "must not replace enrolled credentials" });
    await withTenant(runner, bootstrapOrganizationId, async (tx) => {
      const preserved = await tx.userAccount.findFirstOrThrow({ where: { id: admin.id }, include: { person: true } });
      expect(preserved.passwordHash).toBe(admin.passwordHash);
      expect(preserved.mfaRequired).toBe(true);
      expect(preserved.person.displayName).toBe("Owner-managed profile");
      expect((await tx.authCredential.findFirstOrThrow({ where: { id: credentialBefore.id } })).secretHash).toBe(credentialBefore.secretHash);
      expect((await tx.authCredential.findFirstOrThrow({ where: { id: totp.credentialId } })).secretEncrypted === enrolled.secretEncrypted).toBe(true);
    });
    expect(await validateAuthSession({ organizationId: firstFactor.organizationId, userAccountId: firstFactor.id, sessionId: firstFactor.sessionId, sessionVersion: firstFactor.sessionVersion })).toEqual({ valid: false });
    const assertion = await beginPasskeyAuthentication(email, { db: runner, origin });
    const proof = await verifyPasskeyAuthentication(email, assertion.challengeId, authenticator.authentication(assertion.options, origin), { db: runner, origin });
    const handoff = await beginVerifiedPasskeyLogin({ email, ...proof, deviceId: "integration-enrollment-device" });
    const authenticated = await authenticateMfaChallenge({ email, challengeToken: handoff.challengeToken, deviceId: "integration-enrollment-device", mfaCode: totpCode(totp.secret), headers: new Headers() });
    if (!authenticated) throw new Error("Expected real passkey and TOTP authentication");
    expect(authenticated.securitySetupRequired).toBe(false);
    const ctx = { organizationId: bootstrapOrganizationId, actorId: admin.id, personId: admin.personId,
      authContext: await authContextForAccount(bootstrapOrganizationId, admin.id, { db: runner }) };
    const passwordReset = await issueRecoveryCode(ctx, admin.id, { db: runner });
    expect(await authenticatePassword({ email, password: "local integration bootstrap password", recoveryCode: passwordReset, deviceId: "integration-enrollment-device", headers: new Headers() })).toBeNull();
    const invitedEmail = `idn-invitation-${randomUUID()}@example.test`;
    const invitation = await createInvitation(ctx, { displayName: "Identity integration invite", email: invitedEmail,
      phone: "+212699000002", roleKey: "field_staff", scopeType: "organization", expiresInHours: 1 }, { db: runner });
    // A wrong phone is rejected but the limiter transaction still commits.
    await expect(activateInvitation({ code: invitation.code, phone: "+212699000099", pin: "654321" }, { db: runner })).rejects.toThrow(/phone verification/u);
    const results = await Promise.allSettled([1, 2].map(() => activateInvitation({ code: invitation.code,
      phone: "+212699000002", pin: "654321", password: "local invitation password" }, { db: runner })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const account = await withTenant(runner, bootstrapOrganizationId, (tx) => tx.userAccount.findFirstOrThrow({ where: { email: invitedEmail } }));
    const recoveryCode = await issueRecoveryCode(ctx, account.id, { db: runner });
    const recovered = await Promise.allSettled([1, 2].map(() => recoverPassword({ email: invitedEmail,
      recoveryCode, newPassword: "local recovered identity password" }, { db: runner })));
    expect(recovered.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const credential = await withTenant(runner, bootstrapOrganizationId, (tx) => tx.authCredential.findFirstOrThrow({ where: { userAccountId: account.id, type: "PASSWORD", revokedAt: null } }));
    await revokeCredential(ctx, credential.id, { db: runner });
    await withTenant(runner, bootstrapOrganizationId, async (tx) => {
      expect((await tx.userAccount.findFirstOrThrow({ where: { id: account.id } })).passwordHash).toBeNull();
      expect(await tx.authCredential.count({ where: { userAccountId: account.id, type: "PASSWORD", revokedAt: null } })).toBe(0);
      expect(await tx.authCredential.count({ where: { userAccountId: account.id, type: "PIN" } })).toBe(1);
      const invitationBucket = await tx.rateLimitBucket.findMany({ where: { windowSeconds: 900 } });
      expect(invitationBucket.some((bucket) => bucket.count === 3)).toBe(true);
    });
    const offboardCode = await issueRecoveryCode(ctx, account.id, { db: runner });
    const offboardRace = await Promise.allSettled([
      deactivateAccount(ctx, account.id, { db: runner }),
      recoverPassword({ email: invitedEmail, recoveryCode: offboardCode,
        newPassword: "concurrent recovery must remain offboarded" }, { db: runner })
    ]);
    expect(offboardRace[0].status).toBe("fulfilled");
    await withTenant(runner, bootstrapOrganizationId, async (tx) => {
      expect((await tx.userAccount.findFirstOrThrow({ where: { id: account.id } })).status).toBe("DEACTIVATED");
    });
    await expect(recoverPassword({ email: invitedEmail, recoveryCode: offboardCode,
      newPassword: "must not reactivate offboarded account" }, { db: runner })).rejects.toThrow();
  });

  it("supports password MFA challenges with atomic consumption and tenant isolation", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({ data: { name: "MFA tenant A", baseCurrency: "MAD" } }),
      prisma.organization.create({ data: { name: "MFA tenant B", baseCurrency: "MAD" } })
    ]);
    const challenge = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, (tx) =>
      tx.authChallenge.create({ data: {
        organizationId: orgA.id, type: "PASSWORD_MFA", challenge: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      } })
    );
    const wrongTenant = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, (tx) =>
      tx.authChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: new Date() } })
    );
    expect(wrongTenant.count).toBe(0);
    const attempts = await Promise.all([1, 2].map(() =>
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, (tx) =>
        tx.authChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() }
        })
      )
    ));
    expect(attempts.map((attempt) => attempt.count).sort()).toEqual([0, 1]);
    await expect(withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, (tx) =>
      tx.authChallenge.create({ data: {
        organizationId: orgA.id, type: "UNSUPPORTED", challenge: randomUUID(), expiresAt: new Date()
      } })
    )).rejects.toThrow(/auth_challenge_type_check/u);
  });

  it("enforces audit log append-only behavior", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Test", baseCurrency: "MAD" }
    });
    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: org.id,
            action: "test.audit",
            resourceType: "organization",
            resourceId: org.id,
            requestId: "test-request"
          }
        })
    );

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.auditLog.update({
          where: { id: audit.id },
          data: { reason: "should fail" }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.auditLog.delete({
          where: { id: audit.id }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
  });

  it("enforces tenant isolation with PostgreSQL RLS", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: "ALVILLAS RLS A", baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: "ALVILLAS RLS B", baseCurrency: "MAD" }
      })
    ]);

    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: orgA.id,
            action: "test.rls",
            resourceType: "organization",
            resourceId: orgA.id,
            requestId: "test-request-rls"
          }
        })
    );

    const visibleToOrgA = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.auditLog.findFirst({ where: { id: audit.id } })
    );
    const visibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.auditLog.findFirst({ where: { id: audit.id } })
    );
    const visibleWithoutTenant = await prisma.auditLog.findFirst({ where: { id: audit.id } });

    expect(visibleToOrgA?.id).toBe(audit.id);
    expect(visibleToOrgB).toBeNull();
    expect(visibleWithoutTenant).toBeNull();
  });

  it("redacts sensitive audit payloads through the real PostgreSQL writer", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Audit Redaction", baseCurrency: "MAD" }
    });

    await withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
      writeAuditEvent(tx, {
        organizationId: org.id,
        actorId: null,
        action: "identity.account.recover",
        resourceType: "identity",
        resourceId: org.id,
        ipAddress: "127.0.0.1",
        before: {
          email: "owner@example.test",
          nested: {
            passwordHash: "hash",
            safeValue: "kept"
          }
        },
        after: {
          token: "secret-token",
          publicStatus: "ACTIVE"
        },
        reason: "Redaction integration test",
        requestId: "audit-redaction-test",
        occurredAt: new Date("2026-10-12T10:00:00.000Z")
      })
    );

    const row = await withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: org.id,
          action: "identity.account.recover"
        }
      })
    );

    expect(row.before).toEqual({
      email: REDACTED_AUDIT_VALUE,
      nested: {
        passwordHash: REDACTED_AUDIT_VALUE,
        safeValue: "kept"
      }
    });
    expect(row.after).toEqual({
      token: REDACTED_AUDIT_VALUE,
      publicStatus: "ACTIVE"
    });
  });

  it("covers every required audit event family with complete PostgreSQL rows", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Audit Coverage", baseCurrency: "MAD" }
    });

    await withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) => {
      for (const eventFamily of requiredAuditEventCoverage) {
        await writeAuditEvent(tx, {
          organizationId: org.id,
          actorId: integrationActorId,
          action: eventFamily.canonicalActions[0],
          resourceType: "audit_coverage",
          resourceId: org.id,
          ipAddress: "127.0.0.1",
          deviceId: "coverage-device",
          before: { category: eventFamily.category, previousState: "before" },
          after: { category: eventFamily.category, nextState: "after" },
          reason: `Coverage for ${eventFamily.label}`,
          requestId: `audit-coverage-${eventFamily.category}`,
          occurredAt: new Date("2026-10-12T11:00:00.000Z")
        });
      }
    });

    const rows = await withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
      tx.auditLog.findMany({
        where: {
          organizationId: org.id,
          resourceType: "audit_coverage"
        },
        orderBy: { requestId: "asc" }
      })
    );

    expect(rows).toHaveLength(requiredAuditEventCoverage.length);
    expect(rows.map((row) => row.action).sort()).toEqual(
      requiredAuditEventCoverage.map((entry) => entry.canonicalActions[0]).sort()
    );
    for (const row of rows) {
      expect(row.actorId).toBe(integrationActorId);
      expect(row.ipAddress).toBe("127.0.0.1");
      expect(row.deviceId).toBe("coverage-device");
      expect(row.reason).toMatch(/^Coverage for /u);
      expect(row.before).toBeTruthy();
      expect(row.after).toBeTruthy();
      expect(row.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("enforces owner and property tenant isolation with PostgreSQL RLS", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: "ALVILLAS Core RLS A", baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: "ALVILLAS Core RLS B", baseCurrency: "MAD" }
      })
    ]);

    const created = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const actorPerson = await tx.person.create({
          data: {
            id: integrationPersonId,
            organizationId: orgA.id,
            displayName: "Integration Field Worker",
            email: `integration-worker-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        await tx.userAccount.create({
          data: {
            id: integrationActorId,
            organizationId: orgA.id,
            personId: actorPerson.id,
            email: `integration-worker-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "Scoped Owner",
            email: "scoped-owner@example.test",
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Scoped",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool", "garden"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true
              }
            }
          }
        });

        return { owner, property };
      }
    );

    const ownerVisibleToOrgA = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.owner.findFirst({ where: { id: created.owner.id } })
    );
    const ownerVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.owner.findFirst({ where: { id: created.owner.id } })
    );
    const propertyVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.property.findFirst({ where: { id: created.property.id } })
    );
    const linkVisibleWithoutTenant = await prisma.propertyOwner.findFirst({
      where: { propertyId: created.property.id }
    });

    expect(ownerVisibleToOrgA?.id).toBe(created.owner.id);
    expect(ownerVisibleToOrgB).toBeNull();
    expect(propertyVisibleToOrgB).toBeNull();
    expect(linkVisibleWithoutTenant).toBeNull();
  });

  it("manages organization settings with RBAC, RLS, audit and locked base currency", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Organization A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Organization B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const ctx: OrganizationActorContext = {
      organizationId: orgA.id,
      actorId,
      personId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("organization", "view"),
          permissionKey("organization", "edit"),
          permissionKey("organization", "configure")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };

    const initial = await getOrganizationSettings(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const updated = await updateOrganizationSettings(
      ctx,
      {
        name: "ALVILLAS Operating Company",
        legalName: "ALVILLAS SARL",
        brandName: "ALVILLAS",
        baseCurrency: "EUR",
        logoUrl: "https://assets.example.test/alvillas-logo.png",
        primaryColor: "#0B6B5F",
        accentColor: "#9F3F1B",
        websiteUrl: "https://www.alvillas.com",
        supportEmail: "support@alvillas.com",
        supportPhone: "+212600000000",
        defaultLocale: "fr",
        timezone: "Africa/Casablanca",
        countryCode: "MA",
        fiscalYearStartMonth: 1
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-organization-settings-update",
        ipAddress: "127.0.0.1"
      }
    );

    expect(initial.brandName).toBe(orgA.name);
    expect(updated).toMatchObject({
      name: "ALVILLAS Operating Company",
      brandName: "ALVILLAS",
      baseCurrency: "EUR",
      supportEmail: "support@alvillas.com",
      baseCurrencyLocked: false
    });

    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
      organization: await tx.organization.findFirstOrThrow({ where: { id: orgA.id } }),
      profile: await tx.organizationProfile.findFirstOrThrow({ where: { organizationId: orgA.id } }),
      audit: await tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: orgA.id,
          requestId: "integration-organization-settings-update"
        }
      })
    }));
    const profileVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.organizationProfile.findFirst({ where: { organizationId: orgA.id } })
    );
    const profileVisibleWithoutTenant = await prisma.organizationProfile.findFirst({
      where: { organizationId: orgA.id }
    });

    expect(stored.organization.baseCurrency).toBe("EUR");
    expect(stored.profile).toMatchObject({
      brandName: "ALVILLAS",
      defaultLocale: "fr",
      countryCode: "MA",
      createdBy: actorId
    });
    expect(stored.audit).toMatchObject({
      action: "organization.settings.update",
      resourceType: "organization",
      resourceId: orgA.id,
      actorId,
      reason: "Organization settings updated"
    });
    expect(stored.audit.before).toMatchObject({ baseCurrency: "MAD" });
    expect(stored.audit.after).toMatchObject({ baseCurrency: "EUR", brandName: "ALVILLAS" });
    expect(profileVisibleToOrgB).toBeNull();
    expect(profileVisibleWithoutTenant).toBeNull();

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.organizationProfile.delete({ where: { organizationId: orgA.id } })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);

    const editOnlyCtx: OrganizationActorContext = {
      ...ctx,
      authContext: {
        ...ctx.authContext,
        permissions: new Set([permissionKey("organization", "view"), permissionKey("organization", "edit")])
      }
    };

    await expect(
      updateOrganizationSettings(editOnlyCtx, { ...updated, baseCurrency: "USD" }, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-organization-currency-denied"
      })
    ).rejects.toBeInstanceOf(OrganizationAuthorizationError);

    await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
      tx.ledgerAccount.create({
        data: {
          organizationId: orgA.id,
          code: `BANK_${randomUUID().replace(/-/gu, "").slice(0, 8).toUpperCase()}`,
          name: "Currency lock bank",
          accountType: "ASSET_LOCATION",
          normalSide: "DEBIT"
        }
      })
    );
    const locked = await getOrganizationSettings(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });

    expect(locked.baseCurrencyLocked).toBe(true);
    await expect(
      updateOrganizationSettings(ctx, { ...updated, baseCurrency: "USD" }, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-organization-currency-locked"
      })
    ).rejects.toBeInstanceOf(OrganizationCurrencyLockedError);
  });

  it("manages regions and cities with RBAC, RLS, audit, immutable rows and property scopes", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Geography A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Geography B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const geographyCtx: OrganizationActorContext = {
      organizationId: orgA.id,
      actorId,
      personId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("region", "view"),
          permissionKey("region", "create"),
          permissionKey("region", "edit"),
          permissionKey("city", "view"),
          permissionKey("city", "create"),
          permissionKey("city", "edit")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };

    const deniedGeographyCtx: OrganizationActorContext = {
      ...geographyCtx,
      authContext: {
        ...geographyCtx.authContext,
        permissions: new Set([permissionKey("region", "view"), permissionKey("city", "view")])
      }
    };

    await expect(
      createRegion(
        deniedGeographyCtx,
        { name: "Denied Region", code: undefined, sortOrder: 0 },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-geography-denied"
        }
      )
    ).rejects.toBeInstanceOf(GeographyAuthorizationError);

    const region = await createRegion(
      geographyCtx,
      {
        name: "Marrakech-Safi",
        code: "MS",
        description: "Marrakech operating region",
        sortOrder: 10
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-region-create",
        ipAddress: "127.0.0.1"
      }
    );
    const city = await createCity(
      geographyCtx,
      {
        name: "Marrakech",
        regionId: region.id,
        countryCode: "MA",
        timezone: "Africa/Casablanca",
        sortOrder: 10
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-city-create",
        ipAddress: "127.0.0.1"
      }
    );
    const otherCity = await createCity(
      geographyCtx,
      {
        name: "Essaouira",
        regionId: region.id,
        countryCode: "MA",
        timezone: "Africa/Casablanca",
        sortOrder: 20
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-city-create-other"
      }
    );
    const archiveRegionCandidate = await createRegion(
      geographyCtx,
      { name: "Archive Candidate", code: undefined, sortOrder: 99 },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-region-archive-candidate"
      }
    );
    const archiveCityCandidate = await createCity(
      geographyCtx,
      {
        name: "Archive Candidate City",
        regionId: archiveRegionCandidate.id,
        countryCode: "MA",
        timezone: "Africa/Casablanca",
        sortOrder: 99
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-city-archive-candidate"
      }
    );
    const coreCtx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const owner = await createOwner(
      coreCtx,
      {
        displayName: "Geography Owner",
        preferredLocale: "en",
        representatives: [],
        payoutMethods: []
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-geography-owner-create"
      }
    );
    const property = await createProperty(
      coreCtx,
      {
        ownerId: owner.id,
        cityId: city.id,
        name: "Villa Geography Marrakech",
        addressLine1: "Route de Fes",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: [],
        status: "DRAFT",
        onboardingProfile: {
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-geography-property-create"
      }
    );
    const otherProperty = await createProperty(
      coreCtx,
      {
        ownerId: owner.id,
        cityId: otherCity.id,
        name: "Villa Geography Essaouira",
        addressLine1: "Medina",
        countryCode: "MA",
        propertyType: "Riad",
        bedrooms: 3,
        bathrooms: 3,
        livingSpaces: 1,
        hasPool: false,
        hasGarden: false,
        parkingSpaces: 0,
        maxGuests: 6,
        timezone: "Africa/Casablanca",
        amenities: ["terrace"],
        photoUrls: [],
        status: "DRAFT",
        onboardingProfile: {
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-geography-other-property-create"
      }
    );

    expect(property).toMatchObject({
      cityId: city.id,
      regionId: region.id,
      city: "Marrakech",
      region: "Marrakech-Safi"
    });
    expect(otherProperty.cityId).toBe(otherCity.id);

    const cityScopedProperties = await listProperties(
      {
        ...coreCtx,
        authContext: {
          ...coreCtx.authContext,
          scopes: [{ organizationId: orgA.id, scopeType: "city", scopeId: city.id }]
        }
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );

    expect(cityScopedProperties.map((entry) => entry.id)).toEqual([property.id]);

    const geography = await listGeography(geographyCtx, { db: prisma as unknown as TenantTransactionRunner });
    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
      region: await tx.region.findFirstOrThrow({ where: { id: region.id } }),
      city: await tx.city.findFirstOrThrow({ where: { id: city.id } }),
      property: await tx.property.findFirstOrThrow({ where: { id: property.id } }),
      auditActions: await tx.auditLog.findMany({
        where: {
          organizationId: orgA.id,
          action: { in: ["region.create", "city.create"] },
          resourceId: { in: [region.id, city.id] }
        },
        orderBy: { action: "asc" }
      })
    }));
    const cityVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.city.findFirst({ where: { id: city.id } })
    );
    const cityVisibleWithoutTenant = await prisma.city.findFirst({ where: { id: city.id } });

    expect(geography.regions.some((entry) => entry.id === region.id)).toBe(true);
    expect(geography.cities.some((entry) => entry.id === city.id)).toBe(true);
    expect(stored.region.organizationId).toBe(orgA.id);
    expect(stored.city.organizationId).toBe(orgA.id);
    expect(stored.property).toMatchObject({
      cityId: city.id,
      regionId: region.id,
      city: "Marrakech",
      region: "Marrakech-Safi"
    });
    expect(stored.auditActions.map((entry) => entry.action).sort()).toEqual(["city.create", "region.create"]);
    expect(cityVisibleToOrgB).toBeNull();
    expect(cityVisibleWithoutTenant).toBeNull();

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.city.delete({ where: { id: archiveCityCandidate.id } })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);
    await expect(
      archiveCity(geographyCtx, city.id, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-city-archive-conflict"
      })
    ).rejects.toBeInstanceOf(GeographyConflictError);
    await expect(
      archiveRegion(geographyCtx, region.id, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-region-archive-conflict"
      })
    ).rejects.toBeInstanceOf(GeographyConflictError);

    const archivedCity = await archiveCity(geographyCtx, archiveCityCandidate.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-city-archive"
    });
    const archivedRegion = await archiveRegion(geographyCtx, archiveRegionCandidate.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-region-archive"
    });

    expect(archivedCity.archivedAt).toBeInstanceOf(Date);
    expect(archivedRegion.archivedAt).toBeInstanceOf(Date);

    const directProperty = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
      tx.property.create({
        data: {
          organizationId: orgA.id,
          name: "Villa Legacy Geography Resolver",
          addressLine1: "Legacy Address",
          city: "Legacy City",
          region: "Legacy Region",
          countryCode: "MA",
          propertyType: "Villa",
          bedrooms: 2,
          bathrooms: 2,
          livingSpaces: 1,
          maxGuests: 4,
          timezone: "Africa/Casablanca",
          amenities: [],
          photoUrls: [],
          propertyOwners: {
            create: {
              organizationId: orgA.id,
              ownerId: owner.id,
              shareBps: 10000,
              isPrimary: true,
              createdBy: actorId
            }
          },
          createdBy: actorId
        }
      })
    );

    expect(directProperty.cityId).toEqual(expect.any(String));
    expect(directProperty.regionId).toEqual(expect.any(String));
  });

  it("creates owner representatives, encrypted payout methods and property onboarding profiles", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS ORG Core A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS ORG Core B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const payoutDetails = "IBAN MA64011519000001205000534921 RIB 1234567890";

    const owner = await createOwner(
      ctx,
      {
        displayName: "Owner With Delegate",
        legalName: "Owner With Delegate SARL",
        email: `owner-delegate-${randomUUID()}@example.test`,
        phone: "+212600000000",
        preferredLocale: "en",
        notes: "Owner with representative and encrypted payout method",
        representatives: [
          {
            displayName: "Owner Delegate",
            email: `delegate-${randomUUID()}@example.test`,
            phone: "+212611111111",
            preferredLocale: "fr",
            relationship: "Family office",
            accessNotes: "Can approve owner-facing operating questions",
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
            validTo: new Date("2027-01-01T00:00:00.000Z")
          }
        ],
        payoutMethods: [
          {
            label: "Main MAD bank",
            methodType: "BANK_TRANSFER",
            accountHolderName: "Owner With Delegate SARL",
            currency: "MAD",
            countryCode: "MA",
            detailsPlaintext: payoutDetails,
            isDefault: true
          }
        ]
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-owner-create",
        ipAddress: "127.0.0.1"
      }
    );
    const property = await createProperty(
      ctx,
      {
        ownerId: owner.id,
        name: "Villa ORG Profile",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden", "fiber"],
        photoUrls: ["https://assets.example.test/villa-org-profile.jpg"],
        status: "DRAFT",
        onboardingProfile: {
          headline: "Calm family villa near the Palmeraie",
          description: "Owner-approved onboarding description.",
          publicDirections: "Meet the host at the main gate.",
          internalAccessNotes: "Key safe behind the service entrance.",
          houseRules: ["No parties", "Quiet after 22:00"],
          onboardingNotes: "Wi-Fi and linen inventory still need final confirmation."
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-property-create",
        ipAddress: "127.0.0.1"
      }
    );
    const [ownerDetail, propertyDetail, stored, orgBRepresentative, orgBPayout, orgBProfile] =
      await Promise.all([
        getOwner(ctx, owner.id, { db: prisma as unknown as TenantTransactionRunner }),
        getProperty(ctx, property.id, { db: prisma as unknown as TenantTransactionRunner }),
        withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
          payout: await tx.ownerPayoutMethod.findFirstOrThrow({
            where: { organizationId: orgA.id, ownerId: owner.id }
          }),
          auditRows: await tx.auditLog.findMany({
            where: {
              organizationId: orgA.id,
              requestId: {
                in: ["integration-org-owner-create", "integration-org-property-create"]
              }
            }
          })
        })),
        withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) =>
          tx.ownerRepresentative.findFirst({ where: { ownerId: owner.id } })
        ),
        withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) =>
          tx.ownerPayoutMethod.findFirst({ where: { ownerId: owner.id } })
        ),
        withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) =>
          tx.propertyOnboardingProfile.findFirst({ where: { propertyId: property.id } })
        )
      ]);

    expect(ownerDetail.representatives).toHaveLength(1);
    expect(ownerDetail.representatives[0]).toMatchObject({
      displayName: "Owner Delegate",
      preferredLocale: "fr",
      relationship: "Family office"
    });
    expect(ownerDetail.payoutMethods).toHaveLength(1);
    expect(ownerDetail.payoutMethods[0]).toMatchObject({
      label: "Main MAD bank",
      maskedAccount: "**** 7890",
      isDefault: true
    });
    expect(stored.payout.detailsEncrypted).not.toContain("1234567890");
    expect(stored.payout.detailsEncrypted).not.toContain("IBAN");
    expect(JSON.stringify(stored.auditRows)).not.toContain("1234567890");
    expect(propertyDetail.onboardingProfile).toMatchObject({
      headline: "Calm family villa near the Palmeraie",
      houseRules: ["No parties", "Quiet after 22:00"],
      photoGallery: [
        {
          url: "https://assets.example.test/villa-org-profile.jpg",
          label: "Photo 1",
          sortOrder: 1
        }
      ]
    });
    expect(orgBRepresentative).toBeNull();
    expect(orgBPayout).toBeNull();
    expect(orgBProfile).toBeNull();
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.ownerPayoutMethod.delete({
          where: { id: stored.payout.id }
        })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);
  });

  it("manages multiple property owners with audited shares and immutable links", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Shares A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Shares B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create"),
          permissionKey("property", "edit")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const [primaryOwner, coOwner, archivedOwner] = await Promise.all([
      createOwner(
        ctx,
        {
          displayName: "Share Primary Owner",
          email: `share-primary-${randomUUID()}@example.test`,
          preferredLocale: "en",
          representatives: [],
          payoutMethods: []
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-owner-shares-primary",
          ipAddress: "127.0.0.1"
        }
      ),
      createOwner(
        ctx,
        {
          displayName: "Share Co Owner",
          email: `share-co-${randomUUID()}@example.test`,
          preferredLocale: "fr",
          representatives: [],
          payoutMethods: []
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-owner-shares-co",
          ipAddress: "127.0.0.1"
        }
      ),
      createOwner(
        ctx,
        {
          displayName: "Share Archived Owner",
          email: `share-archived-${randomUUID()}@example.test`,
          preferredLocale: "fr",
          representatives: [],
          payoutMethods: []
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-owner-shares-archived",
          ipAddress: "127.0.0.1"
        }
      )
    ]);
    const property = await createProperty(
      ctx,
      {
        ownerId: archivedOwner.id,
        name: "Villa Shared Ownership",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: [],
        status: "DRAFT",
        onboardingProfile: {
          headline: "Shared owner villa",
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-owner-shares-property",
        ipAddress: "127.0.0.1"
      }
    );

    const updated = await updatePropertyOwnership(
      ctx,
      {
        propertyId: property.id,
        shares: [
          {
            ownerId: primaryOwner.id,
            shareBps: 6000,
            isPrimary: true
          },
          {
            ownerId: coOwner.id,
            shareBps: 4000,
            isPrimary: false
          }
        ]
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-owner-shares",
        ipAddress: "127.0.0.1"
      }
    );
    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
      links: await tx.propertyOwner.findMany({
        where: { organizationId: orgA.id, propertyId: property.id },
        orderBy: [{ archivedAt: "asc" }, { shareBps: "desc" }]
      }),
      audit: await tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: orgA.id,
          action: "property.ownership.update",
          resourceId: property.id,
          requestId: "integration-org-owner-shares"
        }
      })
    }));
    const visibleToOrgB = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) =>
      tx.propertyOwner.findMany({ where: { propertyId: property.id } })
    );

    expect(updated.owners).toEqual([
      expect.objectContaining({
        id: primaryOwner.id,
        shareBps: 6000,
        isPrimary: true
      }),
      expect.objectContaining({
        id: coOwner.id,
        shareBps: 4000,
        isPrimary: false
      })
    ]);
    expect(stored.links.find((link) => link.ownerId === archivedOwner.id)?.archivedAt).toBeInstanceOf(Date);
    expect(visibleToOrgB).toHaveLength(0);
    expect(stored.audit.before).toEqual({
      owners: [
        expect.objectContaining({
          id: archivedOwner.id,
          shareBps: 10000,
          isPrimary: true
        })
      ]
    });
    expect(stored.audit.after).toEqual({
      owners: [
        expect.objectContaining({
          id: primaryOwner.id,
          shareBps: 6000,
          isPrimary: true
        }),
        expect.objectContaining({
          id: coOwner.id,
          shareBps: 4000,
          isPrimary: false
        })
      ]
    });

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => {
        const primaryLink = stored.links.find((link) => link.ownerId === primaryOwner.id);

        if (!primaryLink) {
          throw new Error("Expected primary owner link");
        }

        await tx.propertyOwner.update({
          where: { id: primaryLink.id },
          data: { shareBps: 5000 }
        });
      })
    ).rejects.toThrow(/shares must total 10000|property owner shares/u);
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => {
        const coOwnerLink = stored.links.find((link) => link.ownerId === coOwner.id);

        if (!coOwnerLink) {
          throw new Error("Expected co-owner link");
        }

        await tx.propertyOwner.delete({
          where: { id: coOwnerLink.id }
        });
      })
    ).rejects.toThrow(/archived, not deleted|business rows/u);
  });

  it("manages property operating profiles with audited service automation settings", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Operating Profile A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Operating Profile B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create"),
          permissionKey("property", "edit")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const owner = await createOwner(
      ctx,
      {
        displayName: "Operating Profile Owner",
        email: `operating-profile-${randomUUID()}@example.test`,
        preferredLocale: "en",
        representatives: [],
        payoutMethods: []
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-operating-profile-owner",
        ipAddress: "127.0.0.1"
      }
    );
    const property = await createProperty(
      ctx,
      {
        ownerId: owner.id,
        name: "Villa Operating Profile",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 4,
        bathrooms: 4,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 8,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: [],
        status: "DRAFT",
        operatingProfile: {
          cleaningEnabled: true,
          cleaningFrequency: "BETWEEN_STAYS",
          inspectionEnabled: true,
          inspectionFrequency: "CHECKOUT",
          poolServiceEnabled: true,
          poolServiceFrequency: "DAILY",
          gardenServiceEnabled: true,
          gardenServiceFrequency: "WEEKLY",
          laundryManaged: true,
          linenManaged: true,
          maintenanceTrackingEnabled: true,
          preventiveMaintenanceFrequency: "ON_DEMAND",
          midStayCleaningEnabled: true,
          midStayCleaningRuleKey: "ops.mid_stay_threshold",
          breakfastAvailable: true,
          chefAvailable: false,
          transfersAvailable: true,
          groceriesAvailable: false,
          wellnessAvailable: false,
          otherServices: ["hammam"],
          automationNotes: "Initial operating profile"
        },
        onboardingProfile: {
          headline: "Operating profile villa",
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-operating-profile-property",
        ipAddress: "127.0.0.1"
      }
    );

    expect(property.operatingProfile).toEqual(expect.objectContaining({
      poolServiceEnabled: true,
      poolServiceFrequency: "DAILY",
      midStayCleaningRuleKey: "ops.mid_stay_threshold"
    }));

    const updated = await updatePropertyOperatingProfile(
      ctx,
      property.id,
      {
        cleaningEnabled: true,
        cleaningFrequency: "BETWEEN_STAYS",
        inspectionEnabled: true,
        inspectionFrequency: "CHECKOUT",
        poolServiceEnabled: true,
        poolServiceFrequency: "DAILY",
        gardenServiceEnabled: true,
        gardenServiceFrequency: "WEEKLY",
        laundryManaged: true,
        linenManaged: true,
        maintenanceTrackingEnabled: true,
        preventiveMaintenanceFrequency: "MONTHLY",
        midStayCleaningEnabled: true,
        midStayCleaningRuleKey: "ops.mid_stay_threshold",
        breakfastAvailable: true,
        chefAvailable: true,
        transfersAvailable: true,
        groceriesAvailable: true,
        wellnessAvailable: true,
        otherServices: ["hammam", "yoga"],
        automationNotes: "Updated automation profile"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-operating-profile-update",
        ipAddress: "127.0.0.1"
      }
    );
    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
      profile: await tx.propertyOperatingProfile.findUniqueOrThrow({
        where: { propertyId: property.id }
      }),
      audit: await tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: orgA.id,
          action: "property.operating_profile.update",
          resourceId: property.id,
          requestId: "integration-org-operating-profile-update"
        }
      })
    }));
    const visibleToOrgB = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) =>
      tx.propertyOperatingProfile.findMany({ where: { propertyId: property.id } })
    );

    expect(updated.operatingProfile).toEqual(expect.objectContaining({
      chefAvailable: true,
      groceriesAvailable: true,
      wellnessAvailable: true,
      preventiveMaintenanceFrequency: "MONTHLY",
      otherServices: ["hammam", "yoga"]
    }));
    expect(stored.profile.otherServices).toEqual(["hammam", "yoga"]);
    expect(visibleToOrgB).toHaveLength(0);
    const auditBefore = stored.audit.before as {
      operatingProfile?: { chefAvailable?: boolean; midStayCleaningRuleKey?: string | null };
    };
    const auditAfter = stored.audit.after as {
      operatingProfile?: { chefAvailable?: boolean; groceriesAvailable?: boolean; wellnessAvailable?: boolean };
    };

    expect(auditBefore.operatingProfile).toMatchObject({
      chefAvailable: false,
      midStayCleaningRuleKey: "ops.mid_stay_threshold"
    });
    expect(auditAfter.operatingProfile).toMatchObject({
      chefAvailable: true,
      groceriesAvailable: true,
      wellnessAvailable: true
    });

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.propertyOperatingProfile.delete({ where: { propertyId: property.id } })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);
  });

  it("configures property booking channels with masked endpoints, audit, and tenant isolation", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Booking Channel A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Booking Channel B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create"),
          permissionKey("property", "edit")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const owner = await createOwner(
      ctx,
      {
        displayName: "Booking Channel Owner",
        email: `booking-channel-${randomUUID()}@example.test`,
        preferredLocale: "en",
        representatives: [],
        payoutMethods: []
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-booking-channel-owner",
        ipAddress: "127.0.0.1"
      }
    );
    const property = await createProperty(
      ctx,
      {
        ownerId: owner.id,
        name: "Villa Booking Channels",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: ["https://assets.example.test/booking-channel-villa.jpg"],
        status: "DRAFT",
        onboardingProfile: {
          headline: "Booking channel villa",
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-booking-channel-property",
        ipAddress: "127.0.0.1"
      }
    );
    const privateEndpoint = "https://calendar.airbnb.com/ical/private-token.ics";

    await expect(
      upsertPropertyBookingChannel(
        {
          ...ctx,
          authContext: {
            ...ctx.authContext,
            permissions: new Set([permissionKey("property", "view")])
          }
        },
        {
          propertyId: property.id,
          sourceKey: "AIRBNB",
          displayName: "Airbnb Palmeraie",
          externalListingId: "airbnb-denied",
          listingUrl: "https://www.airbnb.com/rooms/123456",
          syncMode: "ICAL",
          importEnabled: true,
          exportEnabled: false,
          syncEndpointUrl: privateEndpoint,
          status: "ACTIVE"
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-booking-channel-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);

    const created = await upsertPropertyBookingChannel(
      ctx,
      {
        propertyId: property.id,
        sourceKey: "AIRBNB",
        displayName: "Airbnb Palmeraie",
        externalListingId: "airbnb-123",
        listingUrl: "https://www.airbnb.com/rooms/123456",
        syncMode: "ICAL",
        importEnabled: true,
        exportEnabled: false,
        syncEndpointUrl: privateEndpoint,
        status: "ACTIVE"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-booking-channel-create",
        ipAddress: "127.0.0.1"
      }
    );
    const updated = await upsertPropertyBookingChannel(
      ctx,
      {
        propertyId: property.id,
        sourceKey: "AIRBNB",
        displayName: "Airbnb Palmeraie Direct",
        externalListingId: "airbnb-456",
        listingUrl: "https://www.airbnb.com/rooms/456789",
        syncMode: "ICAL",
        importEnabled: true,
        exportEnabled: true,
        status: "PAUSED"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-booking-channel-update",
        ipAddress: "127.0.0.1"
      }
    );
    const propertyWithChannel = await getProperty(ctx, property.id, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => ({
      channel: await tx.bookingChannel.findUniqueOrThrow({
        where: { id: created.id }
      }),
      audits: await tx.auditLog.findMany({
        where: {
          organizationId: orgA.id,
          action: "property.booking_channel.upsert",
          resourceId: created.id
        },
        orderBy: [{ occurredAt: "asc" }]
      })
    }));
    const visibleToOrgB = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) => ({
      audits: await tx.auditLog.findMany({ where: { resourceId: created.id } }),
      channels: await tx.bookingChannel.findMany({ where: { propertyId: property.id } })
    }));
    const auditJson = JSON.stringify(stored.audits);

    expect(created).toMatchObject({
      sourceKey: "AIRBNB",
      displayName: "Airbnb Palmeraie",
      maskedSyncEndpoint: "https://calendar.airbnb.com/***",
      status: "ACTIVE"
    });
    expect(updated).toMatchObject({
      id: created.id,
      displayName: "Airbnb Palmeraie Direct",
      externalListingId: "airbnb-456",
      exportEnabled: true,
      maskedSyncEndpoint: "https://calendar.airbnb.com/***",
      status: "PAUSED"
    });
    expect(propertyWithChannel.bookingChannels).toHaveLength(1);
    expect(propertyWithChannel.bookingChannels[0]).toMatchObject({
      id: created.id,
      displayName: "Airbnb Palmeraie Direct",
      maskedSyncEndpoint: "https://calendar.airbnb.com/***"
    });
    expect(stored.channel).toMatchObject({
      organizationId: orgA.id,
      propertyId: property.id,
      sourceKey: "AIRBNB",
      status: "PAUSED",
      maskedSyncEndpoint: "https://calendar.airbnb.com/***"
    });
    expect(stored.channel.syncEndpointEncrypted ?? "").not.toContain("private-token");
    expect(stored.channel.syncEndpointEncrypted ?? "").not.toContain("calendar.airbnb.com");
    expect(stored.audits).toHaveLength(2);
    expect(auditJson).toContain("https://calendar.airbnb.com/***");
    expect(auditJson).not.toContain("private-token");
    expect(auditJson).not.toContain("/ical/");
    expect(visibleToOrgB).toEqual({
      audits: [],
      channels: []
    });

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.bookingChannel.delete({ where: { id: created.id } })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);
  });

  it("creates management agreements as audited agreement-scoped config history", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Management Agreement A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Management Agreement B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create"),
          permissionKey("property", "edit"),
          permissionKey("config_rule", "view"),
          permissionKey("config_rule", "create"),
          permissionKey("config_rule", "configure")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const owner = await createOwner(
      ctx,
      {
        displayName: "Management Agreement Owner",
        email: `management-agreement-${randomUUID()}@example.test`,
        preferredLocale: "en",
        representatives: [],
        payoutMethods: []
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-management-agreement-owner",
        ipAddress: "127.0.0.1"
      }
    );
    const property = await createProperty(
      ctx,
      {
        ownerId: owner.id,
        name: "Villa Management Agreement",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: [],
        status: "ACTIVE",
        onboardingProfile: {
          headline: "Management agreement villa",
          houseRules: []
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-management-agreement-property",
        ipAddress: "127.0.0.1"
      }
    );
    const input = {
      propertyId: property.id,
      reference: "MA-2026-001",
      status: "ACTIVE" as const,
      effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      effectiveTo: new Date("2028-02-01T00:00:00.000Z"),
      commissionRateBps: 1800,
      commissionBasis: "GROSS_ACCOMMODATION" as const,
      commissionAccrualEvent: "ON_CHECKOUT" as const,
      expenseDefaultTreatment: "DEDUCT_FROM_PAYOUT" as const,
      approvalThresholdKey: "maintenance",
      approvalThresholdAmount: "2500.00",
      approvalThresholdCurrency: "MAD",
      approvalRequires: ["manager" as const, "owner" as const],
      payoutCadence: "MONTHLY" as const,
      payoutHoldDays: 7,
      payoutHoldbackBps: 500,
      noticePeriodDays: 60,
      ownerResponsibilities: ["insurance", "major repairs"],
      alvillasResponsibilities: ["guest operations", "owner reporting"],
      specialConditions: ["ramadan staffing plan"],
      reason: "Signed owner management agreement"
    };

    await expect(
      createManagementAgreement(
        {
          ...ctx,
          authContext: {
            ...ctx.authContext,
            permissions: new Set([
              permissionKey("property", "edit"),
              permissionKey("config_rule", "view"),
              permissionKey("config_rule", "create")
            ])
          }
        },
        input,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-management-agreement-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);

    const agreement = await createManagementAgreement(ctx, input, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-org-management-agreement-create",
      ipAddress: "127.0.0.1"
    });
    const orgCommissionRule = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        new ConfigRuleRepository(tx, orgA.id).createVersion({
          key: "finance.commission",
          scopeType: "organization",
          value: {
            rate_bps: 900,
            basis: "NET_OF_OTA_FEES",
            accrual_event: "ON_RECEIPT"
          },
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          lifecycle: "ACTIVE",
          createdBy: actorId,
          reason: "lower-precedence organization commission"
        })
    );
    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => {
      const agreementRow = await tx.managementAgreement.findUniqueOrThrow({
        where: { id: agreement.id }
      });
      const rules = await tx.configRule.findMany({
        where: {
          organizationId: orgA.id,
          scopeType: "agreement",
          scopeId: agreement.id
        },
        orderBy: [{ key: "asc" }]
      });
      const audit = await tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: orgA.id,
          action: "owner_agreement.changed",
          resourceId: property.id,
          requestId: "integration-org-management-agreement-create"
        }
      });
      const resolvedCommission = await new ConfigRuleRepository(tx, orgA.id).resolve({
        key: "finance.commission",
        asOf: new Date("2026-06-01T00:00:00.000Z"),
        scopes: [
          { scopeType: "agreement", scopeId: agreement.id },
          { scopeType: "property", scopeId: property.id },
          { scopeType: "organization", scopeId: null }
        ]
      });

      return { agreementRow, audit, resolvedCommission, rules };
    });
    const listed = await listPropertyManagementAgreements(ctx, property.id, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const visibleToOrgB = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) => ({
      agreements: await tx.managementAgreement.findMany({ where: { id: agreement.id } }),
      audits: await tx.auditLog.findMany({ where: { resourceId: property.id } }),
      rules: await tx.configRule.findMany({ where: { scopeId: agreement.id } })
    }));
    const rulesByKey = new Map(stored.rules.map((rule) => [rule.key, rule]));
    const commission = rulesByKey.get("finance.commission")?.value as Record<string, unknown> | undefined;
    const expense = rulesByKey.get("finance.expense_treatment")?.value as Record<string, unknown> | undefined;
    const approval = rulesByKey.get("finance.approval_thresholds")?.value as Record<string, unknown> | undefined;
    const payout = rulesByKey.get("finance.payout_schedule")?.value as Record<string, unknown> | undefined;
    const responsibilities = rulesByKey.get("agreement.responsibilities")?.value as Record<string, unknown> | undefined;
    const notice = rulesByKey.get("agreement.notice")?.value as Record<string, unknown> | undefined;
    const conditions = rulesByKey.get("agreement.special_conditions")?.value as Record<string, unknown> | undefined;
    const firstThreshold = Array.isArray(approval?.thresholds)
      ? (approval.thresholds[0] as Record<string, unknown> | undefined)
      : undefined;
    const auditAfter = stored.audit.after as {
      id?: string;
      propertyId?: string;
      reference?: string;
      ruleIds?: Array<{ key?: string; version?: number }>;
    };

    expect(agreement.rules).toHaveLength(7);
    expect(stored.agreementRow).toMatchObject({
      organizationId: orgA.id,
      propertyId: property.id,
      reference: "MA-2026-001",
      status: "ACTIVE"
    });
    expect(stored.rules).toHaveLength(7);
    expect(stored.rules.every((rule) => rule.version === 1 && rule.lifecycle === "ACTIVE")).toBe(true);
    expect(commission).toMatchObject({
      rate_bps: 1800,
      basis: "GROSS_ACCOMMODATION",
      accrual_event: "ON_CHECKOUT"
    });
    expect(expense).toMatchObject({
      default_treatment: "DEDUCT_FROM_PAYOUT"
    });
    expect(firstThreshold).toMatchObject({
      key: "maintenance",
      amount: "2500.00",
      currency: "MAD",
      requires_approval_from: ["manager", "owner"]
    });
    expect(payout).toMatchObject({
      cadence: "MONTHLY",
      hold_days: 7,
      holdback_bps: 500
    });
    expect(responsibilities).toMatchObject({
      owner: ["insurance", "major repairs"],
      alvillas: ["guest operations", "owner reporting"]
    });
    expect(notice).toMatchObject({
      notice_period_days: 60
    });
    expect(conditions).toMatchObject({
      conditions: ["ramadan staffing plan"]
    });
    expect(stored.resolvedCommission?.id).not.toBe(orgCommissionRule.id);
    expect(stored.resolvedCommission?.scopeType).toBe("agreement");
    expect(stored.resolvedCommission?.scopeId).toBe(agreement.id);
    expect(listed.map((item) => item.id)).toContain(agreement.id);
    expect(auditAfter).toMatchObject({
      id: agreement.id,
      propertyId: property.id,
      reference: "MA-2026-001"
    });
    expect(auditAfter.ruleIds).toHaveLength(7);
    expect(visibleToOrgB).toEqual({
      agreements: [],
      audits: [],
      rules: []
    });

    const amended = await amendManagementAgreement(
      ctx,
      {
        propertyId: property.id,
        agreementId: agreement.id,
        effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
        effectiveTo: new Date("2028-02-01T00:00:00.000Z"),
        commissionRateBps: 2000,
        commissionBasis: "NET_OF_OTA_FEES",
        commissionAccrualEvent: "ON_RECEIPT",
        expenseDefaultTreatment: "OWNER_PAID",
        approvalThresholdKey: "maintenance",
        approvalThresholdAmount: "3000.00",
        approvalThresholdCurrency: "MAD",
        approvalRequires: ["owner" as const],
        payoutCadence: "MONTHLY",
        payoutHoldDays: 10,
        payoutHoldbackBps: 250,
        noticePeriodDays: 75,
        ownerResponsibilities: ["insurance"],
        alvillasResponsibilities: ["guest operations", "owner reporting"],
        specialConditions: ["summer staffing plan"],
        reason: "Signed amendment v2 with new owner terms"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-management-agreement-amend",
        ipAddress: "127.0.0.1"
      }
    );
    const amendmentStored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => {
      const rules = await tx.configRule.findMany({
        where: {
          organizationId: orgA.id,
          scopeType: "agreement",
          scopeId: agreement.id,
          key: "finance.commission"
        },
        orderBy: [{ version: "asc" }]
      });
      const historicalCommission = await new ConfigRuleRepository(tx, orgA.id).resolve({
        key: "finance.commission",
        asOf: new Date("2026-06-01T00:00:00.000Z"),
        scopes: [
          { scopeType: "agreement", scopeId: agreement.id },
          { scopeType: "property", scopeId: property.id },
          { scopeType: "organization", scopeId: null }
        ]
      });
      const amendedCommission = await new ConfigRuleRepository(tx, orgA.id).resolve({
        key: "finance.commission",
        asOf: new Date("2026-10-01T00:00:00.000Z"),
        scopes: [
          { scopeType: "agreement", scopeId: agreement.id },
          { scopeType: "property", scopeId: property.id },
          { scopeType: "organization", scopeId: null }
        ]
      });
      const amendmentAudit = await tx.auditLog.findFirstOrThrow({
        where: {
          organizationId: orgA.id,
          action: "owner_agreement.changed",
          resourceId: property.id,
          requestId: "integration-org-management-agreement-amend"
        }
      });
      const agreementRows = await tx.managementAgreement.findMany({
        where: { organizationId: orgA.id, propertyId: property.id }
      });

      return { amendedCommission, amendmentAudit, agreementRows, historicalCommission, rules };
    });

    expect(amended.rules.filter((rule) => rule.key === "finance.commission")).toHaveLength(2);
    expect(amendmentStored.rules.map((rule) => rule.version)).toEqual([1, 2]);
    expect(amendmentStored.rules[0]?.value).toMatchObject({ rate_bps: 1800 });
    expect(amendmentStored.rules[1]?.value).toMatchObject({ rate_bps: 2000 });
    expect(amendmentStored.historicalCommission?.version).toBe(1);
    expect(amendmentStored.amendedCommission?.version).toBe(2);
    expect(amendmentStored.agreementRows).toHaveLength(1);
    expect(amendmentStored.amendmentAudit.before).toBeTruthy();
    expect(amendmentStored.amendmentAudit.after).toBeTruthy();

    const commissionRule = rulesByKey.get("finance.commission");

    if (!commissionRule) {
      throw new Error("commission rule should have been created");
    }

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.configRule.update({
          where: { id: commissionRule.id },
          data: { reason: "forbidden agreement history mutation" }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.managementAgreement.delete({
          where: { id: agreement.id }
        })
      )
    ).rejects.toThrow(/archived, not deleted|business rows/u);
  });

  it("moves properties through lifecycle states with activation prerequisites and audit history", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Property Lifecycle A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Property Lifecycle B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const ctx: CoreActorContext = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        permissions: new Set([
          permissionKey("owner", "view"),
          permissionKey("owner", "create"),
          permissionKey("property", "view"),
          permissionKey("property", "create"),
          permissionKey("property", "edit"),
          permissionKey("config_rule", "view"),
          permissionKey("config_rule", "create"),
          permissionKey("config_rule", "configure")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const owner = await createOwner(
      ctx,
      {
        displayName: "Lifecycle Owner",
        email: `lifecycle-owner-${randomUUID()}@example.test`,
        preferredLocale: "en",
        representatives: [],
        payoutMethods: []
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-owner",
        ipAddress: "127.0.0.1"
      }
    );
    const property = await createProperty(
      ctx,
      {
        ownerId: owner.id,
        name: "Villa Lifecycle",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden"],
        photoUrls: ["https://assets.example.test/lifecycle-villa.jpg"],
        status: "DRAFT",
        operatingProfile: {
          cleaningEnabled: true,
          cleaningFrequency: "BETWEEN_STAYS",
          inspectionEnabled: true,
          inspectionFrequency: "CHECKOUT",
          poolServiceEnabled: true,
          poolServiceFrequency: "DAILY",
          gardenServiceEnabled: true,
          gardenServiceFrequency: "WEEKLY",
          laundryManaged: true,
          linenManaged: true,
          maintenanceTrackingEnabled: true,
          preventiveMaintenanceFrequency: "MONTHLY",
          midStayCleaningEnabled: true,
          midStayCleaningRuleKey: "ops.mid_stay_threshold",
          breakfastAvailable: true,
          chefAvailable: true,
          transfersAvailable: true,
          groceriesAvailable: true,
          wellnessAvailable: false,
          otherServices: ["hammam"],
          automationNotes: "Lifecycle activation profile"
        },
        onboardingProfile: {
          headline: "Lifecycle-ready villa",
          description: "Owner-approved activation profile.",
          publicDirections: "Meet at the main gate.",
          internalAccessNotes: "Key safe behind service door.",
          houseRules: ["No parties"],
          onboardingNotes: "Ready for activation checks."
        }
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-property",
        ipAddress: "127.0.0.1"
      }
    );

    await expect(
      transitionPropertyLifecycle(
        ctx,
        {
          propertyId: property.id,
          status: "ACTIVE",
          reason: "Attempt to skip onboarding"
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-lifecycle-invalid-skip",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(CoreValidationError);

    const onboarding = await transitionPropertyLifecycle(
      ctx,
      {
        propertyId: property.id,
        status: "ONBOARDING",
        reason: "Onboarding checklist started"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-onboarding",
        ipAddress: "127.0.0.1"
      }
    );

    expect(onboarding.status).toBe("ONBOARDING");
    await expect(
      transitionPropertyLifecycle(
        ctx,
        {
          propertyId: property.id,
          status: "ACTIVE",
          reason: "Attempt to activate before agreement"
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-org-lifecycle-missing-agreement",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(CoreValidationError);

    await createManagementAgreement(
      ctx,
      {
        propertyId: property.id,
        reference: `MA-LIFECYCLE-${randomUUID()}`,
        status: "ACTIVE",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        effectiveTo: new Date("2028-02-01T00:00:00.000Z"),
        commissionRateBps: 1800,
        commissionBasis: "GROSS_ACCOMMODATION",
        commissionAccrualEvent: "ON_CHECKOUT",
        expenseDefaultTreatment: "DEDUCT_FROM_PAYOUT",
        approvalThresholdKey: "maintenance",
        approvalThresholdAmount: "2500.00",
        approvalThresholdCurrency: "MAD",
        approvalRequires: ["manager", "owner"],
        payoutCadence: "MONTHLY",
        payoutHoldDays: 7,
        payoutHoldbackBps: 500,
        noticePeriodDays: 60,
        ownerResponsibilities: ["insurance", "major repairs"],
        alvillasResponsibilities: ["guest operations", "owner reporting"],
        specialConditions: ["lifecycle activation"],
        reason: "Signed owner management agreement"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-agreement",
        ipAddress: "127.0.0.1"
      }
    );

    const active = await transitionPropertyLifecycle(
      ctx,
      {
        propertyId: property.id,
        status: "ACTIVE",
        reason: "Activation requirements complete"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-active",
        ipAddress: "127.0.0.1"
      }
    );
    const paused = await transitionPropertyLifecycle(
      ctx,
      {
        propertyId: property.id,
        status: "PAUSED",
        reason: "Owner requested temporary pause"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-paused",
        ipAddress: "127.0.0.1"
      }
    );
    const offboarded = await transitionPropertyLifecycle(
      ctx,
      {
        propertyId: property.id,
        status: "OFFBOARDED",
        reason: "Owner offboarded property"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-org-lifecycle-offboarded",
        ipAddress: "127.0.0.1"
      }
    );

    expect(active.status).toBe("ACTIVE");
    expect(paused.status).toBe("PAUSED");
    expect(offboarded.status).toBe("OFFBOARDED");

    const stored = await withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) => {
      const auditRows = await tx.auditLog.findMany({
        where: {
          organizationId: orgA.id,
          action: "property.lifecycle.transition",
          resourceId: property.id
        },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }]
      });
      const finalProperty = await tx.property.findUniqueOrThrow({ where: { id: property.id } });

      return { auditRows, finalProperty };
    });
    const visibleToOrgB = await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) => ({
      audits: await tx.auditLog.findMany({ where: { resourceId: property.id } }),
      property: await tx.property.findFirst({ where: { id: property.id } })
    }));
    const detail = await getProperty(ctx, property.id, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const activeAudit = stored.auditRows.find((row) => row.requestId === "integration-org-lifecycle-active");
    const activeAuditAfter = activeAudit?.after as
      | { readiness?: Array<{ key?: string; passed?: boolean }>; status?: string }
      | undefined;

    expect(stored.finalProperty.status).toBe("OFFBOARDED");
    expect(stored.auditRows).toHaveLength(4);
    expect(stored.auditRows.map((row) => row.reason)).toEqual([
      "Onboarding checklist started",
      "Activation requirements complete",
      "Owner requested temporary pause",
      "Owner offboarded property"
    ]);
    expect(activeAuditAfter?.status).toBe("ACTIVE");
    expect(activeAuditAfter?.readiness?.every((requirement) => requirement.passed)).toBe(true);
    expect(detail.status).toBe("OFFBOARDED");
    expect(detail.lifecycleEvents.map((event) => event.toStatus)).toEqual([
      "OFFBOARDED",
      "PAUSED",
      "ACTIVE",
      "ONBOARDING"
    ]);
    expect(visibleToOrgB).toEqual({
      audits: [],
      property: null
    });

    if (!activeAudit) {
      throw new Error("Expected ACTIVE lifecycle audit row");
    }

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.auditLog.update({
          where: { id: activeAudit.id },
          data: { reason: "forbidden lifecycle audit mutation" }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
  });

  it("offboards identity accounts with PIN reset, device revoke, assignment archive and tenant isolation", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Identity Lifecycle A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Identity Lifecycle B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);

    await ensureStandardIdentitySetup(orgA.id, {
      db: prisma as unknown as TenantTransactionRunner
    });

    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const adminPerson = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Identity Lifecycle Admin",
            email: `identity-admin-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const adminAccount = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: adminPerson.id,
            email: `identity-admin-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const targetPerson = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Identity Lifecycle Field",
            email: `identity-field-${randomUUID()}@example.test`,
            phone: `+212610${Date.now().toString().slice(-6)}`,
            preferredLocale: "en"
          }
        });
        const targetAccount = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: targetPerson.id,
            email: targetPerson.email,
            phone: targetPerson.phone,
            status: "ACTIVE"
          }
        });
        const role = await tx.role.findFirstOrThrow({
          where: { organizationId: orgA.id, key: "field_staff" }
        });
        const assignment = await tx.roleAssignment.create({
          data: {
            organizationId: orgA.id,
            personId: targetPerson.id,
            userAccountId: targetAccount.id,
            roleId: role.id,
            scopeType: "organization",
            createdBy: adminAccount.id
          }
        });
        const pinCredential = await tx.authCredential.create({
          data: {
            organizationId: orgA.id,
            userAccountId: targetAccount.id,
            type: "PIN",
            label: "Original PIN",
            secretHash: await hashCredentialSecret("123456")
          }
        });
        const device = await tx.authDevice.create({
          data: {
            organizationId: orgA.id,
            userAccountId: targetAccount.id,
            deviceId: "identity-lifecycle-device-a",
            label: "Field tablet",
            platform: "Playwright",
            lastSeenAt: new Date()
          }
        });
        const session = await tx.authSession.create({
          data: {
            organizationId: orgA.id,
            userAccountId: targetAccount.id,
            deviceId: device.deviceId,
            sessionVersion: targetAccount.sessionVersion,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            lastSeenAt: new Date()
          }
        });

        return { adminPerson, adminAccount, targetPerson, targetAccount, assignment, pinCredential, device, session };
      }
    );
    const otherTenantDevice = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => {
        const person = await tx.person.create({
          data: {
            organizationId: orgB.id,
            displayName: "Other Tenant Field",
            email: `other-field-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const account = await tx.userAccount.create({
          data: {
            organizationId: orgB.id,
            personId: person.id,
            email: person.email,
            status: "ACTIVE"
          }
        });

        return tx.authDevice.create({
          data: {
            organizationId: orgB.id,
            userAccountId: account.id,
            deviceId: "identity-lifecycle-other-tenant",
            label: "Other tenant tablet"
          }
        });
      }
    );
    const permissions = new Set([
      permissionKey("identity", "view"),
      permissionKey("identity", "create"),
      permissionKey("identity", "edit"),
      permissionKey("identity", "assign"),
      permissionKey("identity", "override")
    ]);
    const ctx = {
      organizationId: orgA.id,
      actorId: fixture.adminAccount.id,
      personId: fixture.adminPerson.id,
      authContext: {
        organizationId: orgA.id,
        userAccountId: fixture.adminAccount.id,
        personId: fixture.adminPerson.id,
        permissions,
        scopes: [{ organizationId: orgA.id, scopeType: "organization" as const }],
        assignments: [
          {
            roleKey: "admin",
            permissions,
            scope: { organizationId: orgA.id, scopeType: "organization" as const }
          }
        ]
      }
    };
    const duplicatePhone = `+212612${Date.now().toString().slice(-6)}`;
    const profile = await createPersonProfile(
      ctx,
      {
        displayName: "Standalone Person",
        email: `standalone-person-${randomUUID()}@example.test`,
        phone: duplicatePhone,
        preferredLocale: "fr"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-person-create",
        ipAddress: "127.0.0.1"
      }
    );
    await updatePersonProfile(
      ctx,
      {
        personId: profile.id,
        displayName: "Standalone Person Updated",
        email: `standalone-person-updated-${randomUUID()}@example.test`,
        phone: duplicatePhone,
        preferredLocale: "en"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-person-update",
        ipAddress: "127.0.0.1"
      }
    );
    await createPersonProfile(
      ctx,
      {
        displayName: "Duplicate Phone Person",
        email: `duplicate-phone-${randomUUID()}@example.test`,
        phone: duplicatePhone,
        preferredLocale: "en"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-person-duplicate",
        ipAddress: "127.0.0.1"
      }
    );
    const profileDashboard = await listIdentityDashboard(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const updatedProfile = profileDashboard.people.find((person) => person.id === profile.id);

    expect(updatedProfile?.displayName).toBe("Standalone Person Updated");
    expect(updatedProfile?.accountCount).toBe(0);
    expect(
      profileDashboard.duplicateContacts.some(
        (duplicate) => duplicate.contactType === "phone" && duplicate.value === duplicatePhone
      )
    ).toBe(true);

    const invitation = await createInvitation(
      ctx,
      {
        displayName: "Identity Delivery Invite",
        email: `identity-delivery-${randomUUID()}@example.test`,
        phone: "+212611000000",
        roleKey: "field_staff",
        scopeType: "organization",
        preferredLocale: "fr",
        expiresInHours: 24
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-invitation-delivery",
        ipAddress: "127.0.0.1",
        origin: "https://staging.example.test"
      }
    );
    const recoveryCode = await issueRecoveryCode(ctx, fixture.targetAccount.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-idn-recovery-delivery",
      ipAddress: "127.0.0.1",
      origin: "https://staging.example.test"
    });
    const deliveryEvents = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.outboxEvent.findMany({
          where: {
            organizationId: orgA.id,
            type: {
              in: ["identity.invitation.delivery_requested", "identity.recovery.delivery_requested"]
            }
          }
        })
    );
    const invitationDelivery = deliveryEvents.find((event) =>
      event.idempotencyKey.endsWith(invitation.invitationId)
    );
    const recoveryDelivery = deliveryEvents.find(
      (event) => event.type === "identity.recovery.delivery_requested"
    );
    const invitationPayload = invitationDelivery?.payload as Record<string, unknown> | undefined;
    const recoveryPayload = recoveryDelivery?.payload as Record<string, unknown> | undefined;

    expect(invitationDelivery?.status).toBe("PENDING");
    expect(invitationPayload?.activationCode).toBe(invitation.code);
    expect(invitationPayload?.activationUrl).toBe(`https://staging.example.test/fr/activate/${invitation.code}`);
    expect(invitationPayload?.locale).toBe("fr");
    expect(invitationPayload?.channel).toBe("email");
    expect(recoveryDelivery?.status).toBe("PENDING");
    expect(recoveryPayload?.recoveryCode).toBe(recoveryCode);
    expect(recoveryPayload?.recoveryUrl).toBe("https://staging.example.test/en/recover");

    await expect(
      deactivateAccount(
        { ...ctx, actorId: fixture.targetAccount.id, personId: fixture.targetPerson.id },
        fixture.targetAccount.id,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-idn-self-deactivate",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(IdentityConflictError);

    await resetAccountPin(
      ctx,
      {
        userAccountId: fixture.targetAccount.id,
        pin: "987654"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-pin-reset",
        ipAddress: "127.0.0.1"
      }
    );

    const afterPinReset = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        credentials: await tx.authCredential.findMany({
          where: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            type: "PIN"
          },
          orderBy: { createdAt: "asc" }
        }),
        session: await tx.authSession.findFirstOrThrow({
          where: {
            id: fixture.session.id,
            organizationId: orgA.id
          }
        })
      })
    );
    const activePin = afterPinReset.credentials.find((credential) => !credential.revokedAt);
    const originalPin = afterPinReset.credentials.find((credential) => credential.id === fixture.pinCredential.id);

    expect(activePin?.secretHash).toBeTruthy();
    expect(originalPin?.revokedAt).not.toBeNull();
    expect(afterPinReset.session.revokedAt).not.toBeNull();
    expect(activePin?.secretHash ? await verifyPassword("987654", activePin.secretHash) : false).toBe(true);

    const revocableCredential = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const credential = await tx.authCredential.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            type: "PASSWORD",
            label: "Temporary password",
            secretHash: await hashCredentialSecret("temporary-password")
          }
        });
        const session = await tx.authSession.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            deviceId: "identity-lifecycle-credential-device",
            sessionVersion: fixture.targetAccount.sessionVersion + 1,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            lastSeenAt: new Date()
          }
        });

        return { credential, session };
      }
    );
    const credentialDashboard = await listIdentityDashboard(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const targetAccountWithCredentials = credentialDashboard.accounts.find(
      (account) => account.id === fixture.targetAccount.id
    );

    expect(
      targetAccountWithCredentials?.credentials.some(
        (credential) => credential.id === revocableCredential.credential.id
      )
    ).toBe(true);

    await revokeCredential(ctx, revocableCredential.credential.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-idn-credential-revoke",
      ipAddress: "127.0.0.1"
    });

    const afterCredentialRevoke = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        credential: await tx.authCredential.findFirstOrThrow({
          where: { id: revocableCredential.credential.id, organizationId: orgA.id }
        }),
        session: await tx.authSession.findFirstOrThrow({
          where: { id: revocableCredential.session.id, organizationId: orgA.id }
        })
      })
    );

    expect(afterCredentialRevoke.credential.revokedAt).not.toBeNull();
    expect(afterCredentialRevoke.session.revokedAt).not.toBeNull();

    const revocable = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const device = await tx.authDevice.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            deviceId: "identity-lifecycle-device-b",
            label: "Supervisor phone",
            lastSeenAt: new Date()
          }
        });
        const session = await tx.authSession.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            deviceId: device.deviceId,
            sessionVersion: fixture.targetAccount.sessionVersion + 1,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            lastSeenAt: new Date()
          }
        });

        return { device, session };
      }
    );

    await expect(
      revokeDevice(ctx, otherTenantDevice.id, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-idn-cross-tenant-device",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toThrow();

    await revokeDevice(ctx, revocable.device.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-idn-device-revoke",
      ipAddress: "127.0.0.1"
    });

    const afterDeviceRevoke = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        device: await tx.authDevice.findFirstOrThrow({
          where: { id: revocable.device.id, organizationId: orgA.id }
        }),
        session: await tx.authSession.findFirstOrThrow({
          where: { id: revocable.session.id, organizationId: orgA.id }
        })
      })
    );

    expect(afterDeviceRevoke.device.revokedAt).not.toBeNull();
    expect(afterDeviceRevoke.session.revokedAt).not.toBeNull();

    const activeForOffboard = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const device = await tx.authDevice.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            deviceId: "identity-lifecycle-device-c",
            label: "Offboard tablet",
            lastSeenAt: new Date()
          }
        });
        const session = await tx.authSession.create({
          data: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            deviceId: device.deviceId,
            sessionVersion: fixture.targetAccount.sessionVersion + 1,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            lastSeenAt: new Date()
          }
        });

        return { device, session };
      }
    );

    await deactivateAccount(ctx, fixture.targetAccount.id, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-idn-deactivate",
      ipAddress: "127.0.0.1"
    });

    const afterDeactivate = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        account: await tx.userAccount.findFirstOrThrow({
          where: { id: fixture.targetAccount.id, organizationId: orgA.id }
        }),
        activeSessionCount: await tx.authSession.count({
          where: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            revokedAt: null
          }
        }),
        activeDeviceCount: await tx.authDevice.count({
          where: {
            organizationId: orgA.id,
            userAccountId: fixture.targetAccount.id,
            revokedAt: null
          }
        }),
        assignment: await tx.roleAssignment.findFirstOrThrow({
          where: { id: fixture.assignment.id, organizationId: orgA.id }
        }),
        offboardSession: await tx.authSession.findFirstOrThrow({
          where: { id: activeForOffboard.session.id, organizationId: orgA.id }
        }),
        offboardDevice: await tx.authDevice.findFirstOrThrow({
          where: { id: activeForOffboard.device.id, organizationId: orgA.id }
        }),
        auditActions: await tx.auditLog.findMany({
          where: {
            organizationId: orgA.id,
            resourceType: "identity",
            resourceId: fixture.targetAccount.id,
            action: {
              in: [
                "identity.pin.reset",
                "identity.credential.revoke",
                "identity.device.revoke",
                "identity.account.deactivate"
              ]
            }
          },
          select: { action: true }
        })
      })
    );

    expect(afterDeactivate.account.status).toBe("DEACTIVATED");
    expect(afterDeactivate.account.deactivatedAt).not.toBeNull();
    expect(afterDeactivate.activeSessionCount).toBe(0);
    expect(afterDeactivate.activeDeviceCount).toBe(0);
    expect(afterDeactivate.assignment.archivedAt).not.toBeNull();
    expect(afterDeactivate.offboardSession.revokedAt).not.toBeNull();
    expect(afterDeactivate.offboardDevice.revokedAt).not.toBeNull();
    expect(afterDeactivate.auditActions.map((row) => row.action).sort()).toEqual([
      "identity.account.deactivate",
      "identity.credential.revoke",
      "identity.device.revoke",
      "identity.pin.reset"
    ]);
  });

  it("enforces scoped RBAC, ABAC, simulator and field masking from PostgreSQL assignments", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Authorization A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Authorization B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);

    await ensureStandardIdentitySetup(orgA.id, {
      db: prisma as unknown as TenantTransactionRunner
    });

    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const person = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Scoped Co-host",
            email: `cohost-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const account = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: person.id,
            email: `cohost-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const customPerson = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Custom Scoped User",
            email: `custom-role-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const customAccount = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: customPerson.id,
            email: `custom-role-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const expiredPerson = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Expired Scoped User",
            email: `expired-role-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const expiredAccount = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: expiredPerson.id,
            email: `expired-role-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const delegatedPerson = await tx.person.create({
          data: {
            organizationId: orgA.id,
            displayName: "Delegated Scoped User",
            email: `delegated-role-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const delegatedAccount = await tx.userAccount.create({
          data: {
            organizationId: orgA.id,
            personId: delegatedPerson.id,
            email: `delegated-role-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "Authorization Owner",
            email: `auth-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const assignedProperty = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Scoped Co-host",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: account.id
              }
            },
            createdBy: account.id
          }
        });
        const otherProperty = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Other Scope",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 3,
            bathrooms: 3,
            livingSpaces: 1,
            maxGuests: 6,
            timezone: "Africa/Casablanca",
            amenities: [],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: account.id
              }
            },
            createdBy: account.id
          }
        });
        const coHostRole = await tx.role.findFirstOrThrow({
          where: { organizationId: orgA.id, key: "co_host" }
        });
        await tx.roleAssignment.create({
          data: {
            organizationId: orgA.id,
            personId: person.id,
            userAccountId: account.id,
            roleId: coHostRole.id,
            scopeType: "property",
            scopeId: assignedProperty.id,
            createdBy: account.id
          }
        });

        return {
          person,
          account,
          customPerson,
          customAccount,
          expiredPerson,
          expiredAccount,
          delegatedPerson,
          delegatedAccount,
          owner,
          assignedProperty,
          otherProperty
        };
      }
    );

    const adminPermissions = new Set([
      permissionKey("role", "create"),
      permissionKey("role", "edit"),
      permissionKey("role", "assign"),
      permissionKey("role", "override"),
      permissionKey("property", "view"),
      permissionKey("reservation", "view"),
      permissionKey("task", "view"),
      permissionKey("task", "edit")
    ]);
    const adminIdentityCtx = {
      organizationId: orgA.id,
      actorId: fixture.account.id,
      personId: fixture.person.id,
      authContext: {
        organizationId: orgA.id,
        userAccountId: fixture.account.id,
        personId: fixture.person.id,
        permissions: adminPermissions,
        scopes: [{ organizationId: orgA.id, scopeType: "organization" as const }],
        assignments: [
          {
            roleKey: "admin",
            permissions: adminPermissions,
            scope: { organizationId: orgA.id, scopeType: "organization" as const }
          }
        ]
      }
    };
    const customRoleKey = `custom_ops_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const customRole = await createCustomRole(
      adminIdentityCtx,
      {
        key: customRoleKey,
        name: "Custom scoped operations",
        description: "Property-scoped operational role",
        permissionKeys: [
          permissionKey("property", "view"),
          permissionKey("reservation", "view"),
          permissionKey("task", "view")
        ]
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-auz-custom-role",
        ipAddress: "127.0.0.1"
      }
    );
    await updateCustomRole(
      adminIdentityCtx,
      {
        roleId: customRole.id,
        key: customRoleKey,
        name: "Custom scoped operations edited",
        description: "Property-scoped operational role edited",
        permissionKeys: [
          permissionKey("property", "view"),
          permissionKey("reservation", "view"),
          permissionKey("task", "view"),
          permissionKey("task", "edit")
        ]
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-auz-custom-role-edit",
        ipAddress: "127.0.0.1"
      }
    );
    const assignment = await assignRoleToAccount(
      adminIdentityCtx,
      {
        userAccountId: fixture.customAccount.id,
        roleId: customRole.id,
        scopeType: "property",
        scopeId: fixture.assignedProperty.id,
        assignedToMe: false,
        statuses: [],
        conditionStartsAt: new Date("2020-01-01T00:00:00.000Z"),
        conditionEndsAt: new Date("2099-12-31T23:59:59.000Z"),
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validTo: undefined
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-auz-assignment",
        ipAddress: "127.0.0.1"
      }
    );
    await assignRoleToAccount(
      adminIdentityCtx,
      {
        userAccountId: fixture.expiredAccount.id,
        roleId: customRole.id,
        scopeType: "property",
        scopeId: fixture.assignedProperty.id,
        assignedToMe: false,
        statuses: [],
        conditionStartsAt: undefined,
        conditionEndsAt: undefined,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validTo: new Date("2026-01-02T00:00:00.000Z")
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-auz-expired-assignment",
        ipAddress: "127.0.0.1"
      }
    );
    await expect(
      createCustomRole(
        {
          organizationId: orgA.id,
          actorId: fixture.customAccount.id,
          personId: fixture.customPerson.id,
          authContext: {
            organizationId: orgA.id,
            userAccountId: fixture.customAccount.id,
            personId: fixture.customPerson.id,
            permissions: new Set([permissionKey("role", "create")]),
            scopes: [{ organizationId: orgA.id, scopeType: "organization" as const }],
            assignments: [
              {
                roleKey: "limited-role-admin",
                permissions: new Set([permissionKey("role", "create")]),
                scope: { organizationId: orgA.id, scopeType: "organization" as const }
              }
            ]
          }
        },
        {
          key: `bad_finance_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          name: "Bad finance grant",
          description: "Privilege escalation attempt",
          permissionKeys: [permissionKey("financial_transaction", "view")]
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-auz-privilege-escalation",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const adminRole = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.role.findFirstOrThrow({
          where: {
            organizationId: orgA.id,
            key: "admin",
            archivedAt: null
          },
          select: { id: true }
        })
    );
    await expect(
      assignRoleToAccount(
        {
          organizationId: orgA.id,
          actorId: fixture.customAccount.id,
          personId: fixture.customPerson.id,
          authContext: {
            organizationId: orgA.id,
            userAccountId: fixture.customAccount.id,
            personId: fixture.customPerson.id,
            permissions: new Set([permissionKey("role", "assign")]),
            scopes: [{ organizationId: orgA.id, scopeType: "organization" as const }],
            assignments: [
              {
                roleKey: "limited-role-assigner",
                permissions: new Set([permissionKey("role", "assign")]),
                scope: { organizationId: orgA.id, scopeType: "organization" as const }
              }
            ]
          }
        },
        {
          userAccountId: fixture.expiredAccount.id,
          roleId: adminRole.id,
          scopeType: "organization",
          assignedToMe: false,
          statuses: [],
          conditionStartsAt: undefined,
          conditionEndsAt: undefined,
          validFrom: undefined,
          validTo: undefined
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-auz-role-assignment-escalation",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const propertyScopedAssignerPermissions = new Set([
      permissionKey("role", "assign"),
      permissionKey("property", "view"),
      permissionKey("reservation", "view"),
      permissionKey("task", "view"),
      permissionKey("task", "edit")
    ]);
    const propertyScopedAssigner = {
      organizationId: orgA.id,
      actorId: fixture.customAccount.id,
      personId: fixture.customPerson.id,
      authContext: {
        organizationId: orgA.id,
        userAccountId: fixture.customAccount.id,
        personId: fixture.customPerson.id,
        permissions: propertyScopedAssignerPermissions,
        scopes: [{ organizationId: orgA.id, scopeType: "property" as const, scopeId: fixture.assignedProperty.id }],
        assignments: [
          {
            roleKey: "property-role-assigner",
            permissions: propertyScopedAssignerPermissions,
            scope: { organizationId: orgA.id, scopeType: "property" as const, scopeId: fixture.assignedProperty.id }
          }
        ]
      }
    };
    const delegatedAssignment = await assignRoleToAccount(
      propertyScopedAssigner,
      {
        userAccountId: fixture.delegatedAccount.id,
        roleId: customRole.id,
        scopeType: "property",
        scopeId: fixture.assignedProperty.id,
        assignedToMe: false,
        statuses: [],
        conditionStartsAt: undefined,
        conditionEndsAt: undefined,
        validFrom: undefined,
        validTo: undefined
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-auz-property-scoped-assignment",
        ipAddress: "127.0.0.1"
      }
    );
    await expect(
      assignRoleToAccount(
        propertyScopedAssigner,
        {
          userAccountId: fixture.delegatedAccount.id,
          roleId: customRole.id,
          scopeType: "organization",
          assignedToMe: false,
          statuses: [],
          conditionStartsAt: undefined,
          conditionEndsAt: undefined,
          validFrom: undefined,
          validTo: undefined
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-auz-scope-escalation",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);

    const authContext = await authContextForAccount(orgA.id, fixture.account.id, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const customAuthContext = await authContextForAccount(orgA.id, fixture.customAccount.id, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const expiredAuthContext = await authContextForAccount(orgA.id, fixture.expiredAccount.id, {
      db: prisma as unknown as TenantTransactionRunner
    });

    expect(assignment.created).toBe(true);
    expect(delegatedAssignment.created).toBe(true);
    expect(customAuthContext.permissions.has(permissionKey("task", "edit"))).toBe(true);
    expect(expiredAuthContext.permissions.size).toBe(0);

    expect(
      authorize(authContext, "view", {
        type: "property",
        organizationId: orgA.id,
        id: fixture.assignedProperty.id,
        propertyId: fixture.assignedProperty.id
      })
    ).toBe(true);
    expect(
      authorize(authContext, "view", {
        type: "property",
        organizationId: orgA.id,
        id: fixture.otherProperty.id,
        propertyId: fixture.otherProperty.id
      })
    ).toBe(false);
    expect(
      authorize(authContext, "view", {
        type: "reservation",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a001",
        propertyId: fixture.assignedProperty.id
      })
    ).toBe(true);
    expect(
      authorize(authContext, "view", {
        type: "financial_transaction",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a002",
        propertyId: fixture.assignedProperty.id,
        amount: "8000.00",
        dataClass: "financial"
      })
    ).toBe(false);
    expect(
      authorize(authContext, "view", {
        type: "wallet",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a003",
        walletId: "018f0a0b-0000-7000-9000-00000000a003",
        propertyId: fixture.otherProperty.id
      })
    ).toBe(false);
    expect(
      authorize(authContext, "view", {
        type: "property",
        organizationId: orgB.id,
        id: fixture.assignedProperty.id,
        propertyId: fixture.assignedProperty.id
      })
    ).toBe(false);
    expect(
      authorize(customAuthContext, "view", {
        type: "property",
        organizationId: orgA.id,
        id: fixture.assignedProperty.id,
        propertyId: fixture.assignedProperty.id
      })
    ).toBe(true);
    expect(
      authorize(customAuthContext, "view", {
        type: "property",
        organizationId: orgA.id,
        id: fixture.otherProperty.id,
        propertyId: fixture.otherProperty.id
      })
    ).toBe(false);
    expect(
      authorize(customAuthContext, "view", {
        type: "property",
        organizationId: orgB.id,
        id: fixture.assignedProperty.id,
        propertyId: fixture.assignedProperty.id
      })
    ).toBe(false);
    expect(
      authorize(customAuthContext, "view", {
        type: "financial_transaction",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a007",
        propertyId: fixture.assignedProperty.id,
        amount: "8000.00",
        dataClass: "financial"
      })
    ).toBe(false);
    expect(
      authorize(customAuthContext, "edit", {
        type: "task",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a008",
        propertyId: fixture.assignedProperty.id,
        occurredAt: "2026-06-15T12:00:00.000Z"
      })
    ).toBe(true);
    expect(
      authorize(customAuthContext, "edit", {
        type: "task",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a009",
        propertyId: fixture.assignedProperty.id,
        occurredAt: "2100-01-01T00:00:00.000Z"
      })
    ).toBe(false);

    const assignmentCountBefore = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.roleAssignment.count({ where: { organizationId: orgA.id } })
    );
    const simulation = simulateAccess(
      authContext,
      coHostSpecScenarios({
        organizationId: orgA.id,
        assignedPropertyId: fixture.assignedProperty.id,
        otherPropertyId: fixture.otherProperty.id,
        reservationId: "018f0a0b-0000-7000-9000-00000000a004",
        walletId: "018f0a0b-0000-7000-9000-00000000a005"
      })
    );
    const assignmentCountAfter = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.roleAssignment.count({ where: { organizationId: orgA.id } })
    );

    expect(simulation.filter((result) => result.allowed).map((result) => result.key).sort()).toEqual([
      "assigned-property",
      "assigned-reservations",
      "assigned-tasks"
    ]);
    expect(assignmentCountAfter).toBe(assignmentCountBefore);

    type ReservationPreview = {
      id: string;
      guestFirstName: string;
      revenue: string;
      passportUrl: string;
    };
    const policy: FieldPolicy<ReservationPreview> = {
      revenue: { dataClass: "financial" },
      passportUrl: { dataClass: "sensitive", mask: "omit" }
    };
    const presented = present(
      {
        ...authContext,
        visibleDataClasses: new Set<DataClass>(["operational", "guest"])
      } satisfies PresentationContext,
      "view",
      {
        type: "reservation",
        organizationId: orgA.id,
        id: "018f0a0b-0000-7000-9000-00000000a006",
        propertyId: fixture.assignedProperty.id,
        data: {
          id: "018f0a0b-0000-7000-9000-00000000a006",
          guestFirstName: "Nadia",
          revenue: "8000.00 MAD",
          passportUrl: "https://signed.example/passport"
        }
      },
      policy
    );

    expect(presented).toEqual({
      id: "018f0a0b-0000-7000-9000-00000000a006",
      guestFirstName: "Nadia",
      revenue: maskedValue
    });
  });

  it("creates manual reservations with idempotent task generation, overlap detection, and tenant isolation", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Reservations A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Reservations B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);

    const property = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "Reservation Owner",
            email: `reservation-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const createdProperty = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Reservation Flow",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: integrationActorId
              }
            },
            createdBy: integrationActorId
          }
        });

        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "ops.reservation_task_templates",
            scopeType: "organization",
            scopeId: null,
            value: {
              tasks: [
                {
                  key: "arrival",
                  type: "ARRIVAL_PREPARATION",
                  title: {
                    en: "Arrival preparation",
                    fr: "Preparation arrivee"
                  },
                  due: "CHECK_IN",
                  priority: "NORMAL",
                  checklist: [
                    {
                      key: "bedrooms",
                      label: {
                        en: "Bedrooms ready",
                        fr: "Chambres pretes"
                      }
                    },
                    {
                      key: "bathrooms",
                      label: {
                        en: "Bathrooms ready",
                        fr: "Salles de bain pretes"
                      }
                    }
                  ]
                },
                {
                  key: "checkout",
                  type: "CHECKOUT_CLEANING",
                  title: {
                    en: "Checkout cleaning",
                    fr: "Menage depart"
                  },
                  due: "CHECK_OUT",
                  priority: "NORMAL",
                  checklist: [
                    {
                      key: "linen",
                      label: {
                        en: "Linen collected",
                        fr: "Linge collecte"
                      }
                    },
                    {
                      key: "cleaning",
                      label: {
                        en: "Cleaning completed",
                        fr: "Menage termine"
                      }
                    }
                  ]
                }
              ]
            },
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "Integration reservation task templates"
          }
        });

        return createdProperty;
      }
    );

    const ctx = actorForOrganization(orgA.id);
    const firstInput = {
      propertyId: property.id,
      guestName: "S3 Guest One",
      guestEmail: "s3.guest.one@example.test",
      source: "MANUAL" as const,
      checkIn: "2027-03-10",
      checkOut: "2027-03-14",
      adultCount: 2,
      childCount: 1,
      notes: "Manual reservation integration flow",
      idempotencyKey: randomUUID()
    };
    const first = await createManualReservation(ctx, firstInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-reservation-first",
      ipAddress: "127.0.0.1"
    });

    expect(first.idempotent).toBe(false);
    expect(first.reservation.reference).toBe("RES-0001");
    expect(first.conflictCount).toBe(0);
    expect(first.tasks.map((task) => task.title.en).sort()).toEqual([
      "Arrival preparation",
      "Checkout cleaning"
    ]);

    const replay = await createManualReservation(ctx, firstInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-reservation-replay",
      ipAddress: "127.0.0.1"
    });

    expect(replay.idempotent).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.tasks).toHaveLength(2);

    const overlapping = await createManualReservation(
      ctx,
      {
        ...firstInput,
        guestName: "S3 Guest Two",
        guestEmail: "s3.guest.two@example.test",
        checkIn: "2027-03-12",
        checkOut: "2027-03-16",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-reservation-overlap",
        ipAddress: "127.0.0.1"
      }
    );

    expect(overlapping.conflictCount).toBe(1);

    const tasks = await listOperationTasks(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task) => task.assignedToUserAccountId === integrationActorId)).toBe(true);

    const fieldTasks = await listAssignedFieldTasks(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(fieldTasks).toHaveLength(4);
    expect(fieldTasks[0]?.checklistItems).toHaveLength(2);

    const completed = await completeAssignedFieldTask(
      ctx,
      {
        taskId: fieldTasks[0].id,
        idempotencyKey: "018f0a0b-0000-7000-9000-000000000801",
        checklistItemIds: fieldTasks[0].checklistItems.map((item) => item.id),
        note: "Integration field completion"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-field-complete",
        ipAddress: "127.0.0.1"
      }
    );

    expect(completed.state).toBe("COMPLETED");
    expect(completed.completedByUserAccountId).toBe(integrationActorId);
    expect(completed.completionIdempotencyKey).toBe("018f0a0b-0000-7000-9000-000000000801");
    expect(completed.checklistItems.every((item) => item.completedAt)).toBe(true);

    const syncTask = fieldTasks[1];
    const syncPush = {
      device_id: "integration-device-field-01",
      op_schema_version: 1 as const,
      ops: [
        {
          client_op_id: "018f0a0b-0000-7000-9000-000000000802",
          type: "field_task.complete" as const,
          payload: {
            taskId: syncTask.id,
            checklistItemIds: syncTask.checklistItems.map((item) => item.id),
            note: "Integration queued completion"
          },
          client_created_at: "2026-10-11T12:00:00.000Z"
        }
      ]
    };
    const synced = await pushSyncOps(ctx, syncPush, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-field-sync",
      ipAddress: "127.0.0.1"
    });
    const duplicate = await pushSyncOps(ctx, syncPush, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-field-sync-duplicate",
      ipAddress: "127.0.0.1"
    });

    expect(synced.results[0]).toMatchObject({
      client_op_id: "018f0a0b-0000-7000-9000-000000000802",
      status: "APPLIED"
    });
    expect(duplicate.results[0]).toMatchObject({
      client_op_id: "018f0a0b-0000-7000-9000-000000000802",
      status: "DUPLICATE"
    });

    const counts = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        reservations: await tx.reservation.count({ where: { propertyId: property.id } }),
        tasks: await tx.operationTask.count({ where: { propertyId: property.id } }),
        checkItems: await tx.operationTaskChecklistItem.count({ where: { organizationId: orgA.id } }),
        syncOps: await tx.syncOp.count({ where: { organizationId: orgA.id } }),
        conflicts: await tx.reservationConflict.count({
          where: { reservationId: overlapping.reservation.id }
        }),
        audits: await tx.auditLog.findMany({
          where: {
            action: {
              in: ["reservation.create", "reservation.conflict.detected", "task.create", "task.complete"]
            }
          },
          select: { action: true },
          orderBy: { occurredAt: "asc" }
        })
      })
    );

    expect(counts).toMatchObject({
      reservations: 2,
      tasks: 4,
      checkItems: 8,
      syncOps: 1,
      conflicts: 1
    });
    expect(counts.audits.map((audit) => audit.action).sort()).toEqual([
      "reservation.conflict.detected",
      "reservation.create",
      "reservation.create",
      "task.complete",
      "task.complete",
      "task.create",
      "task.create",
      "task.create",
      "task.create"
    ]);

    const reservationVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.reservation.findFirst({ where: { id: first.reservation.id } })
    );
    const taskVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.operationTask.findFirst({ where: { reservationId: first.reservation.id } })
    );
    const conflictVisibleWithoutTenant = await prisma.reservationConflict.findFirst({
      where: { reservationId: overlapping.reservation.id }
    });
    const checklistVisibleWithoutTenant = await prisma.operationTaskChecklistItem.findFirst({
      where: { taskId: completed.id }
    });

    expect(reservationVisibleToOrgB).toBeNull();
    expect(taskVisibleToOrgB).toBeNull();
    expect(conflictVisibleWithoutTenant).toBeNull();
    expect(checklistVisibleWithoutTenant).toBeNull();

    await expect(
      completeAssignedFieldTask(
        actorForOrganization(orgB.id),
        {
          taskId: completed.id,
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000803",
          checklistItemIds: completed.checklistItems.map((item) => item.id)
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-field-cross-tenant",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationNotFoundError);

    await expect(
      createManualReservation(actorForOrganization(orgB.id), firstInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-reservation-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
  });

  it("resolves configurable rules by precedence, effective dates, snapshots and tenant boundaries", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS CFG A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS CFG B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const person = await tx.person.create({
          data: {
            id: personId,
            organizationId: orgA.id,
            displayName: "CFG Integration Admin",
            email: `cfg-admin-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const account = await tx.userAccount.create({
          data: {
            id: actorId,
            organizationId: orgA.id,
            personId: person.id,
            email: `cfg-admin-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "CFG Owner",
            email: `cfg-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa CFG",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 5,
            bathrooms: 5,
            livingSpaces: 2,
            maxGuests: 10,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: actorId
              }
            },
            createdBy: actorId
          }
        });

        return { account, property };
      }
    );
    const configCtx: ConfigActorContext = {
      organizationId: orgA.id,
      actorId,
      personId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("config_rule", "view"),
          permissionKey("config_rule", "create"),
          permissionKey("config_rule", "configure")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const reservationCtx: ReservationActorContext = {
      organizationId: orgA.id,
      actorId,
      personId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("reservation", "view"),
          permissionKey("reservation", "create"),
          permissionKey("task", "view"),
          permissionKey("task", "create")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const taskValue = (key: string, title: string) => ({
      tasks: [
        {
          key,
          type: "ARRIVAL_PREPARATION",
          title: { en: title, fr: title },
          due: "CHECK_IN",
          priority: "NORMAL",
          checklist: []
        }
      ]
    });

    const orgRuleV1 = await createConfigRuleVersion(
      configCtx,
      {
        key: "ops.reservation_task_templates",
        scopeType: "organization",
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify(taskValue("arrival", "Organization arrival")),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        reason: "CFG integration organization v1"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-org-v1",
        ipAddress: "127.0.0.1"
      }
    );
    const orgRuleV2 = await createConfigRuleVersion(
      configCtx,
      {
        key: "ops.reservation_task_templates",
        scopeType: "organization",
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify(taskValue("checkout", "Organization checkout")),
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
        reason: "CFG integration organization v2"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-org-v2",
        ipAddress: "127.0.0.1"
      }
    );
    const propertyRule = await createConfigRuleVersion(
      configCtx,
      {
        key: "ops.reservation_task_templates",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify(taskValue("inspection", "Property inspection")),
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        reason: "CFG integration property override"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-property",
        ipAddress: "127.0.0.1"
      }
    );

    await expect(
      createConfigRuleVersion(
        configCtx,
        {
          key: "finance.payout_schedule",
          scopeType: "organization",
          lifecycle: "ACTIVE",
          valueJson: JSON.stringify({ cadence: "EVERY_WHENEVER" }),
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          reason: "CFG invalid payout"
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-cfg-invalid",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(
      createConfigRuleVersion(
        {
          ...configCtx,
          authContext: {
            ...configCtx.authContext,
            permissions: new Set([permissionKey("config_rule", "view"), permissionKey("config_rule", "create")])
          }
        },
        {
          key: "finance.approval_thresholds",
          scopeType: "organization",
          lifecycle: "ACTIVE",
          valueJson: JSON.stringify({
            thresholds: [
              {
                key: "maintenance",
                amount: "1000.00",
                currency: "MAD",
                requires_approval_from: ["manager"]
              }
            ]
          }),
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          reason: "CFG denied create"
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-cfg-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ConfigAuthorizationError);

    const resolved = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const repository = new ConfigRuleRepository(tx, orgA.id);
        const january = await repository.resolve({
          key: "ops.reservation_task_templates",
          asOf: new Date("2026-01-15T00:00:00.000Z"),
          scopes: [
            { scopeType: "property", scopeId: fixture.property.id },
            { scopeType: "organization", scopeId: null }
          ]
        });
        const april = await repository.resolve({
          key: "ops.reservation_task_templates",
          asOf: new Date("2026-04-01T00:00:00.000Z"),
          scopes: [
            { scopeType: "property", scopeId: fixture.property.id },
            { scopeType: "organization", scopeId: null }
          ]
        });

        return { january, april };
      }
    );

    expect(resolved.january?.id).toBe(orgRuleV1.id);
    expect(resolved.april?.id).toBe(propertyRule.id);

    const reservation = await createManualReservation(
      reservationCtx,
      {
        propertyId: fixture.property.id,
        guestName: "CFG Guest",
        guestEmail: "cfg.guest@example.test",
        source: "MANUAL",
        checkIn: "2027-06-10",
        checkOut: "2027-06-13",
        adultCount: 2,
        childCount: 0,
        notes: "CFG snapshot reservation",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-reservation",
        ipAddress: "127.0.0.1"
      }
    );

    expect(reservation.tasks.map((task) => task.title.en)).toEqual(["Property inspection"]);

    const snapshot = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.reservationConfigSnapshot.findUnique({
          where: {
            organizationId_reservationId_key: {
              organizationId: orgA.id,
              reservationId: reservation.reservation.id,
              key: "ops.reservation_task_templates"
            }
          }
        })
    );

    expect(snapshot?.configRuleId).toBe(propertyRule.id);
    expect(snapshot?.version).toBe(propertyRule.version);
    expect(snapshot?.snapshotValue).toMatchObject({
      config_rule_id: propertyRule.id,
      config_rule_scope_type: "property"
    });

    await retireConfigRuleVersion(
      configCtx,
      {
        ruleId: propertyRule.id,
        effectiveFrom: new Date("2026-05-01T00:00:00.000Z"),
        reason: "CFG integration retire property override"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-retire",
        ipAddress: "127.0.0.1"
      }
    );

    const afterRetire = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        new ConfigRuleRepository(tx, orgA.id).resolve({
          key: "ops.reservation_task_templates",
          asOf: new Date("2026-06-01T00:00:00.000Z"),
          scopes: [
            { scopeType: "property", scopeId: fixture.property.id },
            { scopeType: "organization", scopeId: null }
          ]
        })
    );
    const orgBRule = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.configRule.findFirst({ where: { id: propertyRule.id } })
    );
    const orgBSnapshot = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.reservationConfigSnapshot.findFirst({ where: { id: snapshot?.id } })
    );

    expect(orgRuleV2.version).toBe(2);
    expect(afterRetire?.id).toBe(orgRuleV2.id);
    expect(orgBRule).toBeNull();
    expect(orgBSnapshot).toBeNull();
  });

  it("applies finance and feature-flag configuration through real consumers", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS CFG Consumers A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS CFG Consumers B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const actorId = randomUUID();
    const personId = randomUUID();
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const person = await tx.person.create({
          data: {
            id: personId,
            organizationId: orgA.id,
            displayName: "CFG Consumer Admin",
            email: `cfg-consumer-admin-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const account = await tx.userAccount.create({
          data: {
            id: actorId,
            organizationId: orgA.id,
            personId: person.id,
            email: `cfg-consumer-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "CFG Consumer Owner",
            email: `cfg-consumer-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa CFG Consumers",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: actorId
              }
            },
            createdBy: actorId
          }
        });

        return { account, owner, property };
      }
    );
    const configCtx: ConfigActorContext = {
      organizationId: orgA.id,
      actorId,
      personId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([
          permissionKey("config_rule", "view"),
          permissionKey("config_rule", "create"),
          permissionKey("config_rule", "configure")
        ]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const financeCtx = {
      organizationId: orgA.id,
      actorId,
      authContext: {
        organizationId: orgA.id,
        userAccountId: actorId,
        personId,
        permissions: new Set([permissionKey("financial_transaction", "view")]),
        scopes: [{ organizationId: orgA.id }]
      }
    };
    const asOf = new Date("2026-03-15T00:00:00.000Z");
    const expenseRule = await createConfigRuleVersion(
      configCtx,
      {
        key: "finance.expense_allocation",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({
          default_treatment: "ALVILLAS_PAID",
          categories: {
            maintenance: {
              treatment: "SHARED",
              owner_share_bps: 3000,
              alvillas_share_bps: 7000,
              approval_rule_key: "maintenance-high"
            }
          }
        }),
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        reason: "CFG consumer expense allocation"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-expense-v1",
        ipAddress: "127.0.0.1"
      }
    );
    const expenseRuleV2 = await createConfigRuleVersion(
      configCtx,
      {
        key: "finance.expense_allocation",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({
          default_treatment: "ALVILLAS_PAID",
          categories: {
            maintenance: {
              treatment: "SHARED",
              owner_share_bps: 4000,
              alvillas_share_bps: 6000,
              approval_rule_key: "maintenance-high"
            }
          }
        }),
        effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
        reason: "CFG consumer expense allocation v2"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-expense-v2",
        ipAddress: "127.0.0.1"
      }
    );
    await createConfigRuleVersion(
      configCtx,
      {
        key: "finance.approval_thresholds",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({
          thresholds: [
            {
              key: "maintenance-high",
              category: "maintenance",
              amount: "1000.00",
              currency: "MAD",
              emergency_bypass_owner: true,
              requires_approval_from: ["manager_owner"]
            }
          ]
        }),
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        reason: "CFG consumer approval thresholds"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-approval",
        ipAddress: "127.0.0.1"
      }
    );
    await createConfigRuleVersion(
      configCtx,
      {
        key: "finance.payout_schedule",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({
          cadence: "AFTER_CHECKOUT",
          hold_days: 3,
          holdback_amount: "100.00",
          holdback_currency: "MAD",
          holdback_bps: 1000
        }),
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        reason: "CFG consumer payout schedule"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-payout",
        ipAddress: "127.0.0.1"
      }
    );
    const orgFlag = await createConfigRuleVersion(
      configCtx,
      {
        key: "feature_flag",
        customFeatureFlagKey: "owner_portal",
        scopeType: "organization",
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({ enabled: false, variant: "dark" }),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        reason: "CFG consumer owner portal dark"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-flag-org",
        ipAddress: "127.0.0.1"
      }
    );
    const propertyFlag = await createConfigRuleVersion(
      configCtx,
      {
        key: "feature_flag",
        customFeatureFlagKey: "owner_portal",
        scopeType: "property",
        scopeId: fixture.property.id,
        lifecycle: "ACTIVE",
        valueJson: JSON.stringify({ enabled: true, variant: "pilot", payload: { surface: "owner" } }),
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        reason: "CFG consumer owner portal pilot"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-cfg-consumer-flag-property",
        ipAddress: "127.0.0.1"
      }
    );

    const expenseDecision = await evaluateExpensePolicy(
      financeCtx,
      {
        propertyId: fixture.property.id,
        ownerId: fixture.owner.id,
        category: "maintenance",
        amount: "1500.00",
        currency: "MAD",
        emergency: true,
        asOf
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );
    const payoutPlan = await planOwnerPayout(
      financeCtx,
      {
        propertyId: fixture.property.id,
        ownerId: fixture.owner.id,
        availableBalance: "10000.00",
        currency: "MAD",
        checkoutDate: new Date("2028-04-14T00:00:00.000Z"),
        triggeredAt: new Date("2028-04-15T00:00:00.000Z"),
        asOf
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );
    const disabledFlag = await resolveFeatureFlag(
      {
        organizationId: orgA.id,
        key: "owner_portal",
        propertyId: fixture.property.id,
        asOf: new Date("2026-01-15T00:00:00.000Z"),
        defaultEnabled: false
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );
    const enabledFlag = await resolveFeatureFlag(
      {
        organizationId: orgA.id,
        key: "owner_portal",
        propertyId: fixture.property.id,
        asOf,
        defaultEnabled: false
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );
    const orgBFlag = await resolveFeatureFlag(
      {
        organizationId: orgB.id,
        key: "owner_portal",
        propertyId: fixture.property.id,
        asOf,
        defaultEnabled: false
      },
      { db: prisma as unknown as TenantTransactionRunner }
    );

    expect(expenseDecision.allocationRule.configRuleId).toBe(expenseRule.id);
    expect(expenseDecision.allocation.ownerAmount.toJSON().amount).toBe("450.00");
    expect(expenseDecision.allocation.alvillasAmount.toJSON().amount).toBe("1050.00");
    expect(expenseDecision.approval).toMatchObject({
      matchedThresholdKey: "maintenance-high",
      requiredSteps: ["manager"],
      postHocOwnerNotificationRequired: true
    });
    expect(payoutPlan.payoutRule.key).toBe("finance.payout_schedule");
    expect(payoutPlan.payout.eligibleOn.toISOString()).toBe("2028-04-17T00:00:00.000Z");
    expect(payoutPlan.payout.holdbackAmount.toJSON().amount).toBe("1100.00");
    expect(payoutPlan.payout.payableAmount.toJSON().amount).toBe("8900.00");
    expect(disabledFlag.configRuleId).toBe(orgFlag.id);
    expect(disabledFlag.enabled).toBe(false);
    expect(enabledFlag.configRuleId).toBe(propertyFlag.id);
    expect(enabledFlag.enabled).toBe(true);
    expect(enabledFlag.variant).toBe("pilot");
    expect(orgBFlag.configRuleId).toBeNull();
    expect(orgBFlag.enabled).toBe(false);

    await expect(
      evaluateExpensePolicy(
        {
          ...financeCtx,
          authContext: {
            ...financeCtx.authContext,
            permissions: new Set([])
          }
        },
        {
          propertyId: fixture.property.id,
          category: "maintenance",
          amount: "1500.00",
          currency: "MAD",
          asOf
        },
        { db: prisma as unknown as TenantTransactionRunner }
      )
    ).rejects.toBeInstanceOf(FinanceConfigAuthorizationError);

    const model = await getConfigAdminModel(configCtx, {}, {
      db: prisma as unknown as TenantTransactionRunner
    });
    const expenseV2History = model.rules.find((rule) => rule.id === expenseRuleV2.id);
    expect(expenseV2History?.changedPaths).toContain("categories");

    const auditRows = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.auditLog.findMany({
          where: {
            organizationId: orgA.id,
            action: "config_rule.version.created",
            requestId: {
              in: [
                "integration-cfg-consumer-expense-v1",
                "integration-cfg-consumer-expense-v2",
                "integration-cfg-consumer-approval",
                "integration-cfg-consumer-payout",
                "integration-cfg-consumer-flag-org",
                "integration-cfg-consumer-flag-property"
              ]
            }
          }
        })
    );
    const orgBRule = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.configRule.findFirst({ where: { id: expenseRule.id } })
    );

    expect(auditRows).toHaveLength(6);
    expect(orgBRule).toBeNull();
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.configRule.update({
          where: { id: expenseRule.id },
          data: { reason: "CFG consumer forbidden mutation" }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.configRule.delete({
          where: { id: expenseRule.id }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
  });

  it("derives owner portal statements from PostgreSQL ledger postings and owner scopes", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Portal A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Portal B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const ownerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-a-${randomUUID()}@example.test`
    };
    const otherOwnerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-b-${randomUUID()}@example.test`
    };
    const tenantUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `tenant-${randomUUID()}@example.test`
    };
    const orgBUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-org-b-${randomUUID()}@example.test`
    };

    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const ownerPerson = await tx.person.create({
          data: {
            id: ownerUser.personId,
            organizationId: orgA.id,
            displayName: "Owner Portal Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const ownerAccount = await tx.userAccount.create({
          data: {
            id: ownerUser.userAccountId,
            organizationId: orgA.id,
            personId: ownerPerson.id,
            email: ownerUser.email,
            status: "ACTIVE"
          }
        });
        const otherPerson = await tx.person.create({
          data: {
            id: otherOwnerUser.personId,
            organizationId: orgA.id,
            displayName: "Other Owner Portal Owner",
            email: otherOwnerUser.email,
            preferredLocale: "en"
          }
        });
        const otherAccount = await tx.userAccount.create({
          data: {
            id: otherOwnerUser.userAccountId,
            organizationId: orgA.id,
            personId: otherPerson.id,
            email: otherOwnerUser.email,
            status: "ACTIVE"
          }
        });
        const tenantPerson = await tx.person.create({
          data: {
            id: tenantUser.personId,
            organizationId: orgA.id,
            displayName: "Tenant User Without Owner Scope",
            email: tenantUser.email,
            preferredLocale: "en"
          }
        });
        await tx.userAccount.create({
          data: {
            id: tenantUser.userAccountId,
            organizationId: orgA.id,
            personId: tenantPerson.id,
            email: tenantUser.email,
            status: "ACTIVE"
          }
        });
        const [owner, otherOwner] = await Promise.all([
          tx.owner.create({
            data: {
              organizationId: orgA.id,
              displayName: "Owner Portal Owner",
              email: ownerUser.email,
              preferredLocale: "en"
            }
          }),
          tx.owner.create({
            data: {
              organizationId: orgA.id,
              displayName: "Other Owner",
              email: otherOwnerUser.email,
              preferredLocale: "en"
            }
          })
        ]);
        const [property, otherProperty] = await Promise.all([
          tx.property.create({
            data: {
              organizationId: orgA.id,
              name: "Villa Ledger Scope",
              addressLine1: "Route de Fes",
              city: "Marrakech",
              countryCode: "MA",
              propertyType: "Villa",
              bedrooms: 4,
              bathrooms: 4,
              livingSpaces: 2,
              maxGuests: 8,
              timezone: "Africa/Casablanca",
              amenities: [],
              photoUrls: [],
              propertyOwners: {
                create: {
                  organizationId: orgA.id,
                  ownerId: owner.id,
                  shareBps: 10000,
                  isPrimary: true
                }
              }
            }
          }),
          tx.property.create({
            data: {
              organizationId: orgA.id,
              name: "Villa Other Owner",
              addressLine1: "Route de Fes",
              city: "Marrakech",
              countryCode: "MA",
              propertyType: "Villa",
              bedrooms: 5,
              bathrooms: 5,
              livingSpaces: 2,
              maxGuests: 10,
              timezone: "Africa/Casablanca",
              amenities: [],
              photoUrls: [],
              propertyOwners: {
                create: {
                  organizationId: orgA.id,
                  ownerId: otherOwner.id,
                  shareBps: 10000,
                  isPrimary: true
                }
              }
            }
          })
        ]);
        await Promise.all([
          tx.ownerPortalAccess.create({
            data: {
              organizationId: orgA.id,
              ownerId: owner.id,
              userAccountId: ownerAccount.id
            }
          }),
          tx.ownerPortalAccess.create({
            data: {
              organizationId: orgA.id,
              ownerId: otherOwner.id,
              userAccountId: otherAccount.id
            }
          })
        ]);
        const [bank, ownerPayable, commissionRevenue] = await Promise.all([
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "BANK_A_INTERNAL",
              name: "Operating bank",
              accountType: "ASSET_LOCATION",
              normalSide: "DEBIT"
            }
          }),
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "OWNER_PAYABLE",
              name: "Owner payable",
              accountType: "CLAIM_OWNERSHIP",
              normalSide: "CREDIT"
            }
          }),
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "ALVILLAS_COMMISSION_REVENUE",
              name: "ALVILLAS commission revenue",
              accountType: "ALVILLAS_OWN",
              normalSide: "CREDIT"
            }
          })
        ]);
        const dimensions = {
          owner_id: owner.id,
          property_id: property.id,
          reservation_reference: "RES-OWNER-PORTAL",
          source: "DIRECT"
        };

        async function createOwnerPostingTransaction(input: {
          reference: string;
          occurredAt: Date;
          ownerSide: "DEBIT" | "CREDIT";
          amount: string;
          bucket: string;
          offsetAccountId: string;
          offsetSide: "DEBIT" | "CREDIT";
        }) {
          return tx.financialTransaction.create({
            data: {
              organizationId: orgA.id,
              reference: input.reference,
              occurredAt: input.occurredAt,
              description: input.bucket,
              postings: {
                create: [
                  {
                    organizationId: orgA.id,
                    ledgerAccountId: input.offsetAccountId,
                    side: input.offsetSide,
                    amount: input.amount,
                    currency: "MAD",
                    bucket: input.bucket,
                    dimensions
                  },
                  {
                    organizationId: orgA.id,
                    ledgerAccountId: ownerPayable.id,
                    side: input.ownerSide,
                    amount: input.amount,
                    currency: "MAD",
                    bucket: input.bucket,
                    dimensions
                  }
                ]
              }
            },
            include: {
              postings: true
            }
          });
        }

        await createOwnerPostingTransaction({
          reference: "TX-OPENING",
          occurredAt: new Date("2027-03-25T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "1000.00",
          bucket: "OWNER_REVENUE",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        const revenue = await createOwnerPostingTransaction({
          reference: "TX-REVENUE",
          occurredAt: new Date("2027-04-05T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "8000.00",
          bucket: "OWNER_REVENUE",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-SERVICE",
          occurredAt: new Date("2027-04-06T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "500.00",
          bucket: "OWNER_SERVICES",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-COMMISSION",
          occurredAt: new Date("2027-04-07T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "1600.00",
          bucket: "COMMISSION",
          offsetAccountId: commissionRevenue.id,
          offsetSide: "CREDIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-EXPENSE",
          occurredAt: new Date("2027-04-08T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "600.00",
          bucket: "OWNER_EXPENSE",
          offsetAccountId: bank.id,
          offsetSide: "CREDIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-PAYOUT",
          occurredAt: new Date("2027-04-20T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "2000.00",
          bucket: "PAYOUT",
          offsetAccountId: bank.id,
          offsetSide: "CREDIT"
        });

        const revenueOwnerPostingId = revenue.postings.find(
          (posting) => posting.ledgerAccountId === ownerPayable.id
        )?.id;

        if (!revenueOwnerPostingId) {
          throw new Error("Owner payable posting was not created");
        }

        return {
          owner,
          property,
          otherProperty,
          revenueOwnerPostingId
        };
      }
    );

    const ownerSession = sessionForOwnerPortal({
      organizationId: orgA.id,
      userAccountId: ownerUser.userAccountId,
      personId: ownerUser.personId,
      email: ownerUser.email
    });
    const ownerCtx = await ownerPortalActorContextFromSession(ownerSession, {
      db: prisma as unknown as TenantTransactionRunner
    });

    expect(ownerCtx).not.toBeNull();

    const properties = await listOwnerPortalProperties(ownerCtx!, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(properties.map((property) => property.propertyId)).toEqual([fixture.property.id]);

    const statement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2027-04-01", to: "2027-04-30" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-owner-statement",
        ipAddress: "127.0.0.1"
      }
    );

    expect(statement.openingBalance.toJSON().amount).toBe("1000.00");
    expect(statement.periodCreditTotal.toJSON().amount).toBe("8500.00");
    expect(statement.periodDebitTotal.toJSON().amount).toBe("4200.00");
    expect(statement.closingBalance.toJSON().amount).toBe("5300.00");
    expect(statement.lines.map((line) => line.bucket).sort()).toEqual([
      "COMMISSION",
      "OWNER_EXPENSE",
      "OWNER_REVENUE",
      "OWNER_SERVICES",
      "PAYOUT"
    ]);

    const postingRows = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.$queryRaw<Array<{ side: string; amount: string }>>`
          SELECT p.side, p.amount::text AS amount
          FROM posting p
          INNER JOIN ledger_account la ON la.id = p.ledger_account_id
          INNER JOIN financial_transaction ft ON ft.id = p.transaction_id
          WHERE p.organization_id = ${orgA.id}::uuid
            AND la.code = 'OWNER_PAYABLE'
            AND p.dimensions @> jsonb_build_object(
              'owner_id', ${fixture.owner.id},
              'property_id', ${fixture.property.id}
            )
            AND ft.occurred_at >= ${new Date("2027-04-01T00:00:00.000Z")}
            AND ft.occurred_at < ${new Date("2027-05-01T00:00:00.000Z")}
        `
    );
    const postingCreditTotal = postingRows
      .filter((row) => row.side === "CREDIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const postingDebitTotal = postingRows
      .filter((row) => row.side === "DEBIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const postingNet = postingRows
      .map(signedLedgerAmount)
      .reduce((sum, amount) => sum.plus(amount), new Decimal(1000));

    expect(statement.periodCreditTotal.toJSON().amount).toBe(postingCreditTotal.toFixed(2));
    expect(statement.periodDebitTotal.toJSON().amount).toBe(postingDebitTotal.toFixed(2));
    expect(statement.closingBalance.toJSON().amount).toBe(postingNet.toFixed(2));

    await expect(
      getOwnerStatement(
        ownerCtx!,
        fixture.otherProperty.id,
        { from: "2027-04-01", to: "2027-04-30" },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-owner-statement-other-owner",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(OwnerPortalAuthorizationError);

    const tenantSession = sessionForOwnerPortal({
      organizationId: orgA.id,
      userAccountId: tenantUser.userAccountId,
      personId: tenantUser.personId,
      email: tenantUser.email
    });
    await expect(
      ownerPortalActorContextFromSession(tenantSession, {
        db: prisma as unknown as TenantTransactionRunner
      })
    ).resolves.toBeNull();

    await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) => {
      const person = await tx.person.create({
        data: {
          id: orgBUser.personId,
          organizationId: orgB.id,
          displayName: "Org B Owner",
          email: orgBUser.email,
          preferredLocale: "en"
        }
      });
      await tx.userAccount.create({
        data: {
          id: orgBUser.userAccountId,
          organizationId: orgB.id,
          personId: person.id,
          email: orgBUser.email,
          status: "ACTIVE"
        }
      });
    });
    const revenueVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.posting.findFirst({ where: { id: fixture.revenueOwnerPostingId } })
    );
    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.auditLog.findFirst({
          where: {
            action: "owner_statement.view",
            resourceId: fixture.property.id
          }
        })
    );

    expect(revenueVisibleToOrgB).toBeNull();
    expect(audit?.resourceId).toBe(fixture.property.id);
  });

  it("posts manual reservation revenue to owner and ALVILLAS ledgers exactly once", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Revenue Posting A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Revenue Posting B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const financePermissions = new Set([
      permissionKey("reservation", "view"),
      permissionKey("reservation", "create"),
      permissionKey("task", "view"),
      permissionKey("task", "create"),
      permissionKey("financial_transaction", "view"),
      permissionKey("financial_transaction", "create"),
      permissionKey("financial_transaction", "void")
    ]);
    const ownerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `s6-owner-${randomUUID()}@example.test`
    };
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const ownerPerson = await tx.person.create({
          data: {
            id: ownerUser.personId,
            organizationId: orgA.id,
            displayName: "S6 Owner Portal Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const ownerAccount = await tx.userAccount.create({
          data: {
            id: ownerUser.userAccountId,
            organizationId: orgA.id,
            personId: ownerPerson.id,
            email: ownerUser.email,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "S6 Revenue Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa S6 Revenue",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: integrationActorId
              }
            },
            createdBy: integrationActorId
          }
        });
        await tx.ownerPortalAccess.create({
          data: {
            organizationId: orgA.id,
            ownerId: owner.id,
            userAccountId: ownerAccount.id
          }
        });
        const bank = await tx.ledgerAccount.create({
          data: {
            organizationId: orgA.id,
            code: "BANK_S6_REVENUE",
            name: "S6 operating bank",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "ops.reservation_task_templates",
            scopeType: "organization",
            scopeId: null,
            value: {
              tasks: [
                {
                  key: "arrival",
                  type: "ARRIVAL_PREPARATION",
                  title: {
                    en: "Arrival preparation",
                    fr: "Preparation arrivee"
                  },
                  due: "CHECK_IN",
                  priority: "NORMAL",
                  checklist: []
                }
              ]
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 task templates"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "organization",
            scopeId: null,
            value: {
              rate_bps: 1000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 organization commission fallback"
          }
        });
        const propertyCommissionRule = await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "property",
            scopeId: property.id,
            value: {
              rate_bps: 2000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 property commission"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "property",
            scopeId: property.id,
            value: {
              rate_bps: 3000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
            version: 2,
            createdBy: integrationActorId,
            reason: "S6 future commission change"
          }
        });

        return {
          owner,
          property,
          bank,
          propertyCommissionRule
        };
      }
    );
    const ctx = actorForOrganization(orgA.id, financePermissions);
    const reservation = await createManualReservation(
      ctx,
      {
        propertyId: fixture.property.id,
        guestName: "S6 Revenue Guest",
        guestEmail: "s6.revenue.guest@example.test",
        source: "MANUAL",
        checkIn: "2028-04-10",
        checkOut: "2028-04-14",
        adultCount: 2,
        childCount: 0,
        notes: "S6 reservation revenue posting",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-reservation",
        ipAddress: "127.0.0.1"
      }
    );
    const recordInput = {
      reservationId: reservation.reservation.id,
      amount: "8000.00",
      currency: "MAD",
      receivedAccountId: fixture.bank.id,
      idempotencyKey: randomUUID()
    };

    await expect(
      recordReservationAccommodationRevenue(
        actorForOrganization(
          orgA.id,
          new Set([permissionKey("reservation", "view"), permissionKey("financial_transaction", "view")])
        ),
        recordInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueAuthorizationError);

    const posted = await recordReservationAccommodationRevenue(ctx, recordInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-record",
      ipAddress: "127.0.0.1"
    });

    expect(posted.idempotent).toBe(false);
    expect(posted.commissionTotal.toJSON().amount).toBe("1600.00");
    expect(posted.ownerNetTotal.toJSON().amount).toBe("6400.00");

    const afterPost = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        transactionCount: await tx.financialTransaction.count({
          where: { organizationId: orgA.id }
        }),
        snapshot: await tx.commissionSnapshot.findFirstOrThrow({
          where: {
            reservationId: reservation.reservation.id,
            ownerId: fixture.owner.id
          }
        }),
        postings: await tx.posting.findMany({
          where: {
            transactionId: {
              in: [posted.revenueTransactionId, posted.commissionTransactionId!]
            }
          },
          include: {
            ledgerAccount: true
          }
        }),
        balances: await tx.$queryRaw<Array<{ transactionId: string; balance: string }>>`
          SELECT
            transaction_id AS "transactionId",
            sum(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END)::text AS balance
          FROM posting
          WHERE organization_id = ${orgA.id}::uuid
            AND transaction_id IN (${posted.revenueTransactionId}::uuid, ${posted.commissionTransactionId!}::uuid)
          GROUP BY transaction_id
        `
      })
    );

    expect(afterPost.transactionCount).toBe(2);
    expect(afterPost.snapshot.configRuleId).toBe(fixture.propertyCommissionRule.id);
    expect(afterPost.snapshot.commissionRateBps).toBe(2000);
    expect(afterPost.snapshot.commissionBasis).toBe("GROSS_ACCOMMODATION");
    expect(afterPost.balances.every((row) => new Decimal(row.balance).eq(0))).toBe(true);
    expect(
      afterPost.postings.find(
        (posting) => posting.ledgerAccount.code === "BANK_S6_REVENUE" && posting.side === "DEBIT"
      )?.amount.toString()
    ).toBe("8000");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.bucket === "OWNER_REVENUE" &&
          posting.side === "CREDIT"
      )?.amount.toString()
    ).toBe("8000");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.bucket === "COMMISSION" &&
          posting.side === "DEBIT"
      )?.amount.toString()
    ).toBe("1600");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "ALVILLAS_COMMISSION_REVENUE" &&
          posting.side === "CREDIT"
      )?.amount.toString()
    ).toBe("1600");

    const replay = await recordReservationAccommodationRevenue(ctx, recordInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-record-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(replay.idempotent).toBe(true);
    expect(transactionCountAfterReplay).toBe(2);
    await expect(
      recordReservationAccommodationRevenue(
        ctx,
        {
          ...recordInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-record-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueConflictError);

    const ownerCtx = await ownerPortalActorContextFromSession(
      sessionForOwnerPortal({
        organizationId: orgA.id,
        userAccountId: ownerUser.userAccountId,
        personId: ownerUser.personId,
        email: ownerUser.email
      }),
      {
        db: prisma as unknown as TenantTransactionRunner
      }
    );
    expect(ownerCtx).not.toBeNull();
    const postedStatement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2000-01-01", to: "2099-12-31" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-statement-posted",
        ipAddress: "127.0.0.1"
      }
    );

    expect(postedStatement.closingBalance.toJSON().amount).toBe("6400.00");

    await expect(
      recordReservationAccommodationRevenue(actorForOrganization(orgB.id, financePermissions), recordInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(ReservationRevenueNotFoundError);

    const reversalInput = {
      reservationId: reservation.reservation.id,
      reason: "Integration S6 reversal",
      idempotencyKey: randomUUID()
    };
    const reversed = await reverseReservationAccommodationRevenue(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-reversal",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReverse = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversed.idempotent).toBe(false);
    expect(reversed.reversalTransactionIds).toHaveLength(2);
    expect(transactionCountAfterReverse).toBe(4);
    const reversedStatement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2000-01-01", to: "2099-12-31" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-statement-reversed",
        ipAddress: "127.0.0.1"
      }
    );

    expect(reversedStatement.closingBalance.toJSON().amount).toBe("0.00");

    const reversalReplay = await reverseReservationAccommodationRevenue(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-reversal-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReversalReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversalReplay.idempotent).toBe(true);
    expect(transactionCountAfterReversalReplay).toBe(4);
    await expect(
      reverseReservationAccommodationRevenue(
        ctx,
        {
          ...reversalInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-reversal-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueConflictError);
  });

  it("imports and reconciles Airbnb settlement CSV rows without duplicate postings", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Airbnb Settlement A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Airbnb Settlement B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const financePermissions = new Set([
      permissionKey("reservation", "view"),
      permissionKey("reservation", "create"),
      permissionKey("task", "view"),
      permissionKey("task", "create"),
      permissionKey("financial_transaction", "view"),
      permissionKey("financial_transaction", "create"),
      permissionKey("financial_transaction", "void"),
      permissionKey("financial_transaction", "reconcile")
    ]);
    const externalId = `HM-${randomUUID()}`;
    const sourceTransactionId = `TX-${randomUUID()}`;
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "S7 Airbnb Owner",
            email: `s7-airbnb-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa S7 Airbnb",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: integrationActorId
              }
            },
            createdBy: integrationActorId
          }
        });
        const bank = await tx.ledgerAccount.create({
          data: {
            organizationId: orgA.id,
            code: "BANK_S7_AIRBNB",
            name: "S7 Airbnb settlement bank",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "ops.reservation_task_templates",
            scopeType: "organization",
            scopeId: null,
            value: {
              tasks: [
                {
                  key: "arrival",
                  type: "ARRIVAL_PREPARATION",
                  title: {
                    en: "Arrival preparation",
                    fr: "Preparation arrivee"
                  },
                  due: "CHECK_IN",
                  priority: "NORMAL",
                  checklist: []
                }
              ]
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S7 task templates"
          }
        });

        return { owner, property, bank };
      }
    );
    const ctx = actorForOrganization(orgA.id, financePermissions);
    const reservation = await createManualReservation(
      ctx,
      {
        propertyId: fixture.property.id,
        guestName: "S7 Airbnb Guest",
        guestEmail: "s7.airbnb.guest@example.test",
        source: "AIRBNB",
        externalId,
        checkIn: "2028-05-10",
        checkOut: "2028-05-14",
        adultCount: 2,
        childCount: 0,
        notes: "S7 Airbnb settlement reconciliation",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s7-reservation",
        ipAddress: "127.0.0.1"
      }
    );
    const csv = [
      "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action",
      `${externalId},PO-S7,${sourceTransactionId},MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout`
    ].join("\n");
    const importInput = {
      csv,
      receivedAccountId: fixture.bank.id,
      idempotencyKey: randomUUID()
    };

    await expect(
      importAirbnbSettlementCsv(
        actorForOrganization(
          orgA.id,
          new Set([
            permissionKey("reservation", "view"),
            permissionKey("financial_transaction", "view"),
            permissionKey("financial_transaction", "create")
          ])
        ),
        importInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);

    const imported = await importAirbnbSettlementCsv(ctx, importInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-import",
      ipAddress: "127.0.0.1"
    });
    const importedItem = imported.imported[0];

    expect(importedItem?.idempotent).toBe(false);
    expect(importedItem?.reservationId).toBe(reservation.reservation.id);
    expect(importedItem?.expectedPayout.toJSON().amount).toBe("5200.00");
    expect(importedItem?.actualReceipt.toJSON().amount).toBe("5150.00");
    expect(importedItem?.varianceAmount.toJSON().amount).toBe("50.00");
    expect(importedItem?.varianceId).not.toBeNull();
    const varianceId = importedItem.varianceId;
    if (!varianceId) {
      throw new Error("Expected Airbnb settlement import to create a variance");
    }

    const afterImport = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        transactionCount: await tx.financialTransaction.count({
          where: { organizationId: orgA.id }
        }),
        settlementCount: await tx.airbnbSettlement.count({
          where: { organizationId: orgA.id }
        }),
        varianceCount: await tx.variance.count({
          where: { organizationId: orgA.id, sourceType: "AIRBNB_SETTLEMENT" }
        }),
        postings: await tx.posting.findMany({
          where: {
            transactionId: {
              in: [importedItem.expectedTransactionId, importedItem.receiptTransactionId]
            }
          },
          include: {
            ledgerAccount: true
          }
        }),
        balances: await tx.$queryRaw<Array<{ transactionId: string; balance: string }>>`
          SELECT
            transaction_id AS "transactionId",
            sum(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END)::text AS balance
          FROM posting
          WHERE organization_id = ${orgA.id}::uuid
            AND transaction_id IN (${importedItem.expectedTransactionId}::uuid, ${importedItem.receiptTransactionId}::uuid)
          GROUP BY transaction_id
        `
      })
    );

    expect(afterImport.transactionCount).toBe(2);
    expect(afterImport.settlementCount).toBe(1);
    expect(afterImport.varianceCount).toBe(1);
    expect(afterImport.balances).toHaveLength(2);
    expect(afterImport.balances.every((row) => new Decimal(row.balance).eq(0))).toBe(true);
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OTA_CLEARING_AIRBNB" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_SETTLEMENT"
      )?.amount.toString()
    ).toBe("5200");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_FEE"
      )?.amount.toString()
    ).toBe("300");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.side === "CREDIT" &&
          posting.bucket === "OWNER_REVENUE"
      )?.amount.toString()
    ).toBe("5500");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "BANK_S7_AIRBNB" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_RECEIPT"
      )?.amount.toString()
    ).toBe("5150");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "VARIANCE_SUSPENSE" &&
          posting.side === "DEBIT" &&
          posting.bucket === "VARIANCE"
      )?.amount.toString()
    ).toBe("50");

    const variances = await listAirbnbSettlementVariances(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(variances).toHaveLength(1);
    expect(variances[0]?.expectedAmount.toJSON().amount).toBe("5200.00");
    expect(variances[0]?.actualAmount.toJSON().amount).toBe("5150.00");
    expect(variances[0]?.varianceAmount.toJSON().amount).toBe("50.00");
    expect(variances[0]?.reason).toBe("Bank fee");
    expect(variances[0]?.action).toBe("Review payout");

    const replay = await importAirbnbSettlementCsv(ctx, importInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-import-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(replay.imported[0]?.idempotent).toBe(true);
    expect(transactionCountAfterReplay).toBe(2);
    await expect(
      importAirbnbSettlementCsv(
        ctx,
        {
          ...importInput,
          csv: csv.replace("5150.00", "5140.00"),
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-import-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementConflictError);

    await expect(
      importAirbnbSettlementCsv(actorForOrganization(orgB.id, financePermissions), importInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s7-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(AirbnbSettlementNotFoundError);

    const settlementVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.airbnbSettlement.findFirst({ where: { id: importedItem.settlementId } })
    );
    const varianceVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.variance.findFirst({ where: { id: varianceId } })
    );

    expect(settlementVisibleToOrgB).toBeNull();
    expect(varianceVisibleToOrgB).toBeNull();

    const reversalInput = {
      settlementId: importedItem.settlementId,
      reason: "Integration S7 reversal",
      idempotencyKey: randomUUID()
    };
    await expect(
      reverseAirbnbSettlement(
        actorForOrganization(
          orgA.id,
          new Set([
            permissionKey("financial_transaction", "view"),
            permissionKey("financial_transaction", "reconcile")
          ])
        ),
        reversalInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-reversal-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);

    const postingToMutate = afterImport.postings[0];
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.posting.update({
          where: { id: postingToMutate.id },
          data: { amount: "1.00" }
        })
      )
    ).rejects.toThrow();

    const reversed = await reverseAirbnbSettlement(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-reversal",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReverse = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversed.idempotent).toBe(false);
    expect(reversed.reversalTransactionIds).toHaveLength(2);
    expect(transactionCountAfterReverse).toBe(4);

    const reversalReplay = await reverseAirbnbSettlement(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-reversal-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReversalReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversalReplay.idempotent).toBe(true);
    expect(transactionCountAfterReversalReplay).toBe(4);
    await expect(
      reverseAirbnbSettlement(
        ctx,
        {
          ...reversalInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-reversal-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementConflictError);
  });

  it("allocates tenant-scoped reference numbers under RLS", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS References", baseCurrency: "MAD" }
    });

    const sequence = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) =>
        tx.referenceSequence.create({
          data: {
            organizationId: org.id,
            prefix: "RES",
            nextValue: 2,
            width: 4
          }
        })
    );

    await expect(
      prisma.referenceSequence.findUnique({
        where: { organizationId_prefix: { organizationId: org.id, prefix: "RES" } }
      })
    ).resolves.toBeNull();

    expect(sequence.nextValue).toBe(2n);
  });

  it("enforces balanced append-only ledger transactions", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Ledger", baseCurrency: "MAD" }
    });

    const { bank, ownerPayable, transaction } = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) => {
        const createdBank = await tx.ledgerAccount.create({
          data: {
            organizationId: org.id,
            code: "BANK_A",
            name: "Bank A",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
          }
        });
        const createdOwnerPayable = await tx.ledgerAccount.create({
          data: {
            organizationId: org.id,
            code: "OWNER_PAYABLE",
            name: "Owner Payable",
            accountType: "CLAIM_OWNERSHIP",
            normalSide: "CREDIT"
          }
        });
        const createdTransaction = await tx.financialTransaction.create({
          data: {
            organizationId: org.id,
            reference: "TX-0001",
            occurredAt: new Date("2026-10-11T00:00:00.000Z"),
            postings: {
              create: [
                {
                  organizationId: org.id,
                  ledgerAccountId: createdBank.id,
                  side: "DEBIT",
                  amount: "8000.00",
                  currency: "MAD",
                  bucket: "OWNER_REVENUE"
                },
                {
                  organizationId: org.id,
                  ledgerAccountId: createdOwnerPayable.id,
                  side: "CREDIT",
                  amount: "8000.00",
                  currency: "MAD",
                  bucket: "OWNER_REVENUE"
                }
              ]
            }
          }
        });

        return {
          bank: createdBank,
          ownerPayable: createdOwnerPayable,
          transaction: createdTransaction
        };
      }
    );
    const posting = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) => tx.posting.findFirstOrThrow({ where: { transactionId: transaction.id } })
    );

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.posting.update({
          where: { id: posting.id },
          data: { amount: "1.00" }
        })
      )
    ).rejects.toThrow();

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.financialTransaction.create({
          data: {
            organizationId: org.id,
            reference: "TX-0002",
            occurredAt: new Date("2026-10-11T01:00:00.000Z"),
            postings: {
              create: [
                {
                  organizationId: org.id,
                  ledgerAccountId: bank.id,
                  side: "DEBIT",
                  amount: "100.00",
                  currency: "MAD"
                },
                {
                  organizationId: org.id,
                  ledgerAccountId: ownerPayable.id,
                  side: "CREDIT",
                  amount: "99.99",
                  currency: "MAD"
                }
              ]
            }
          }
        })
      )
    ).rejects.toThrow(/not balanced/u);

    expect(transaction.reference).toBe("TX-0001");
  });
});
