import { provisionIntegrationRole } from "./support/database-role";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { TeamRepository } from "@/modules/identity/infrastructure/team-repository";
import { authContextForAccount } from "@/platform/authz/account-context";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { permissionCatalog } from "@/platform/authz/catalog";
import {
  IdentityAuthorizationError,
  type IdentityActorContext
} from "@/modules/identity/application/identity-access";
import {
  ensureStandardIdentitySetup,
  deactivateAccount,
  getInvitationProfile,
  createInvitation,
  createPersonProfile,
  IdentityConflictError,
  IdentityNotFoundError
} from "@/modules/identity/application/identity-service";
import {
  assignTeamRole,
  saveTeamCompensation,
  teamMember,
  teamDirectory,
  requestTeamAvailability,
  decideTeamAvailability,
  offboardTeamMember,
  linkTeamWallet,
  ownFieldWallet,
  TeamConflictError,
  TeamNotFoundError
} from "@/modules/identity/application/team-service";
import {
  uploadTeamDocument,
  downloadTeamDocument,
  scheduleTeamDocumentReminders,
  archiveTeamDocument,
  type PrivateDocumentStorage
} from "@/modules/identity/application/team-documents";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { getNotificationPage } from "@/platform/notifications/notification-service";
import { ownNotificationContext } from "@/platform/notifications/notification";
import {
  getConfigAdminModel,
  retireConfigRuleVersion,
  ConfigAuthorizationError
} from "@/modules/config/application/config-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient;
let db: PrismaClient;
let applicationUrl: string;
function actor(
  org: string,
  id: string,
  personId: string,
  permissions = new Set(permissionCatalog.map((p) => p.key))
): IdentityActorContext {
  return {
    organizationId: org,
    actorId: id,
    personId,
    authContext: {
      organizationId: org,
      userAccountId: id,
      personId,
      permissions,
      scopes: [{ organizationId: org }]
    }
  };
}
async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Team integration", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const rows = await withTenant(db, org, async (tx) => {
    const person = await tx.person.create({
      data: { organizationId: org, displayName: "Team administrator" }
    });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const staff = await tx.person.create({
      data: {
        organizationId: org,
        displayName: "Staff member",
        email: "private@example.test",
        phone: "+212600000001"
      }
    });
    const staffAccount = await tx.userAccount.create({
      data: { organizationId: org, personId: staff.id }
    });
    const property = await tx.property.create({
      data: {
        organizationId: org,
        name: "Villa team",
        addressLine1: "Test address",
        city: "Marrakech",
        propertyType: "VILLA",
        bedrooms: 2,
        bathrooms: 2,
        maxGuests: 4,
        amenities: [],
        photoUrls: []
      }
    });
    const role = await tx.role.findFirstOrThrow({ where: { organizationId: org, key: "field_staff" } });
    await new ConfigRuleRepository(tx, org).createVersion({
      key: "staff.management_policy",
      scopeType: "organization",
      value: {
        document_max_bytes: 1000000,
        document_reminder_days: [30, 7, 0],
        document_link_seconds: 120
      },
      effectiveFrom: new Date("2020-01-01"),
      reason: "Configure staff document safeguards"
    });
    return { person, account, staff, staffAccount, property, role };
  });
  return { ...rows, org, ctx: actor(org, rows.account.id, rows.person.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function compensationWriter(f: Fixture, conditions?: { maxAmount?: string; timeWindow?: { startsAt: string; endsAt: string } }) {
  return withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["staff_compensation:create", "staff_compensation:view"] } } });
    const role = await tx.role.create({ data: { organizationId: f.org, key: "compensation_writer_" + randomUUID(), name: "Compensation administrator",
      rolePermissions: { create: permissions.map(permission => ({ organizationId: f.org, permissionId: permission.id })) } } });
    return tx.roleAssignment.create({ data: { organizationId: f.org, personId: f.person.id, userAccountId: f.account.id, roleId: role.id,
      scopeType: "organization", conditions, validFrom: new Date("2020-01-01") } });
  });
}
const deps = () => ({ db });
async function assignment(f: Fixture) {
  return assignTeamRole(
    f.ctx,
    {
      personId: f.staff.id,
      roleId: f.role.id,
      scopeType: "property",
      scopeId: f.property.id,
      validFrom: "2027-01-01",
      validTo: null,
      assignedToMe: true,
      reason: "Authorized property staff assignment"
    },
    deps()
  );
}
async function task(f: Fixture, dueDate = "2027-02-02") {
  return withTenant(db, f.org, (tx) =>
    tx.operationTask.create({
      data: {
        organizationId: f.org,
        propertyId: f.property.id,
        type: "POOL",
        state: "PLANNED",
        dueDate: new Date(dueDate),
        titleTranslations: { en: "Pool", fr: "Piscine" },
        assignedToPersonId: f.staff.id,
        assignedToUserAccountId: f.staffAccount.id,
        idempotencyKey: randomUUID()
      }
    })
  );
}
describe("team management on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
      throw new Error("Local TEST_DATABASE_URL is required for team integration");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe"
    });
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_team_tests");
    const app = new URL(url);
    app.username = "alvillas_team_tests";
    app.password = "alvillas_team_tests";
    applicationUrl = app.toString();
    db = new PrismaClient({ datasourceUrl: app.toString() });
  });
  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$disconnect();
  });
  it("invites an explicitly selected active profile without changing its contacts or compensation history", async () => {
    const f = await fixture();
    await compensationWriter(f);
    const person = await createPersonProfile(f.ctx, { displayName: "Existing staff profile", email: "existing-staff@example.test", phone: "+212600000003", preferredLocale: "fr" }, deps());
    const role = await assignTeamRole(f.ctx, { personId: person.id, roleId: f.role.id, scopeType: "property", scopeId: f.property.id, validFrom: "2027-01-01", validTo: null, assignedToMe: true, reason: "Preserve the staff assignment" }, deps());
    await saveTeamCompensation(f.ctx, { assignmentId: role.id, mode: "PER_MONTH", amount: "500.25", currency: "MAD", effectiveFrom: "2027-01-01", expectedVersion: 0, reason: "Preserve the agreed compensation" }, deps());
    const before = await withTenant(db, f.org, async tx => ({ person: await tx.person.findFirstOrThrow({ where: { id: person.id } }), rates: await tx.teamCompensation.findMany({ where: { assignmentId: role.id } }) }));
    const invite = await createInvitation(f.ctx, { personId: person.id, displayName: "Forged replacement name", email: "attacker@example.test", phone: "+212600000999", preferredLocale: "ar", roleKey: "field_staff", scopeType: "property", scopeId: f.property.id, expiresInHours: 24 }, deps());
    const saved = await withTenant(db, f.org, async tx => ({ invitation: await tx.invitation.findFirstOrThrow({ where: { id: invite.invitationId } }), person: await tx.person.findFirstOrThrow({ where: { id: person.id } }), rates: await tx.teamCompensation.findMany({ where: { assignmentId: role.id } }), people: await tx.person.count(), accounts: await tx.userAccount.count({ where: { personId: person.id } }), delivery: await tx.outboxEvent.findFirstOrThrow({ where: { idempotencyKey: `identity.invitation.delivery:${invite.invitationId}` } }) }));
    expect(saved.invitation).toMatchObject({ personId: person.id, email: "existing-staff@example.test", phone: "+212600000003" });
    expect(saved.person).toEqual(before.person);
    expect(saved.rates).toEqual(before.rates);
    expect(saved.people).toBe(3);
    expect(saved.accounts).toBe(0);
    expect(saved.delivery.payload).toMatchObject({ personId: person.id, displayName: "Existing staff profile", toEmail: "existing-staff@example.test", locale: "fr" });
  });
  it("denies foreign, archived and account-backed invitation profiles and role grants outside the actor's scope", async () => {
    const f = await fixture(), foreign = await fixture();
    const person = await createPersonProfile(f.ctx, { displayName: "No login staff", phone: "+212600000004", preferredLocale: "en" }, deps());
    const input = { personId: person.id, displayName: "No login staff", roleKey: "field_staff", scopeType: "property" as const, scopeId: f.property.id, expiresInHours: 24 };
    await expect(getInvitationProfile(f.ctx, foreign.staff.id, deps())).rejects.toBeInstanceOf(IdentityNotFoundError);
    await expect(createInvitation(f.ctx, { ...input, personId: foreign.staff.id }, deps())).rejects.toBeInstanceOf(IdentityNotFoundError);
    await expect(createInvitation(f.ctx, { ...input, personId: f.staff.id }, deps())).rejects.toBeInstanceOf(IdentityConflictError);
    const noEdit = actor(f.org, f.account.id, f.person.id, new Set(["identity:view", "identity:create", "role:assign", "role:override"]));
    await expect(createInvitation(noEdit, input, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const noGrant = actor(f.org, f.account.id, f.person.id, new Set(["identity:view", "identity:create", "identity:edit", "role:assign"]));
    await expect(createInvitation(noGrant, input, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const outside: IdentityActorContext = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [{ permissions: new Set(["identity:view", "identity:create", "identity:edit"]), scope: { organizationId: f.org, scopeType: "organization" } }, { permissions: new Set(["role:assign", "role:override"]), scope: { organizationId: f.org, scopeType: "property", scopeId: randomUUID() } }] } };
    await expect(createInvitation(outside, input, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    await withTenant(db, f.org, tx => tx.person.update({ where: { id: person.id }, data: { archivedAt: new Date() } }));
    await expect(createInvitation(f.ctx, input, deps())).rejects.toBeInstanceOf(IdentityNotFoundError);
    expect(await withTenant(db, f.org, tx => tx.invitation.count())).toBe(0);
  });
  it("isolates directory, documents and foreign-key references across tenants with RLS", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const directory = await teamDirectory(f.ctx, {}, deps());
    expect(directory.people.some((p) => p.id === foreign.staff.id)).toBe(false);
    await expect(
      teamMember(f.ctx, { personId: foreign.staff.id, from: "2027-01-01", until: "2027-03-01" }, deps())
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(
      assignTeamRole(
        f.ctx,
        {
          personId: f.staff.id,
          roleId: f.role.id,
          scopeType: "property",
          scopeId: foreign.property.id,
          validFrom: "2027-01-01",
          validTo: null,
          assignedToMe: false,
          reason: "Cross tenant assignment"
        },
        deps()
      )
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    expect(
      await withTenant(db, foreign.org, (tx) => tx.person.count({ where: { id: f.staff.id } }))
    ).toBe(0);
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.teamAvailability.create({
          data: {
            organizationId: f.org,
            personId: foreign.staff.id,
            kind: "LEAVE",
            status: "REQUESTED",
            startsOn: new Date("2027-01-01"),
            endsOn: new Date("2027-01-03"),
            reason: "Foreign staff reference",
            createdBy: f.ctx.actorId
          }
        })
      )
    ).rejects.toThrow();
  });
  it("preserves multiple scoped assignments and rejects scope escalation", async () => {
    const f = await fixture();
    await assignment(f);
    const second = await withTenant(db, f.org, (tx) =>
      tx.role.findFirstOrThrow({ where: { organizationId: f.org, key: "gardener" } })
    );
    await assignTeamRole(
      f.ctx,
      {
        personId: f.staff.id,
        roleId: second.id,
        scopeType: "organization",
        scopeId: null,
        validFrom: "2027-01-01",
        validTo: null,
        assignedToMe: false,
        reason: "Additional gardening assignment"
      },
      deps()
    );
    const detail = await teamMember(
      f.ctx,
      { personId: f.staff.id, from: "2027-01-01", until: "2027-03-01" },
      deps()
    );
    expect(detail.assignments).toHaveLength(2);
    const limited = actor(f.org, f.ctx.actorId, f.ctx.personId, new Set(["role:assign", "task:view"]));
    limited.authContext.scopes = [
      { organizationId: f.org, scopeType: "property", scopeId: f.property.id }
    ];
    await expect(
      assignTeamRole(
        limited,
        {
          personId: f.staff.id,
          roleId: f.role.id,
          scopeType: "organization",
          scopeId: null,
          validFrom: "2027-01-01",
          validTo: null,
          assignedToMe: false,
          reason: "Attempt escalation"
        },
        deps()
      )
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
  });
  it("versions exact compensation per assignment with concurrent and immutable history safeguards", async () => {
    const f = await fixture(),
      a = await assignment(f);
    await compensationWriter(f);
    const base = {
      assignmentId: a.id,
      expectedVersion: 0,
      mode: "PER_JOB",
      amount: "500.25",
      currency: "MAD",
      effectiveFrom: "2027-01-01",
      reason: "Agreed pool service rate"
    };
    await saveTeamCompensation(f.ctx, base, deps());
    const changes = await Promise.allSettled(
      [1, 2].map(() =>
        saveTeamCompensation(
          f.ctx,
          { ...base, expectedVersion: 1, amount: "600.50", effectiveFrom: "2027-02-01" },
          deps()
        )
      )
    );
    expect(changes.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    const rows = await withTenant(db, f.org, (tx) =>
      tx.teamCompensation.findMany({
        where: { organizationId: f.org, assignmentId: a.id },
        orderBy: { version: "asc" }
      })
    );
    expect(rows.map((r) => r.amount.toFixed(2))).toEqual(["500.25", "600.50"]);
    const resolved = await withTenant(db, f.org, async (tx) => {
      const config = new ConfigRuleRepository(tx, f.org);
      return Promise.all(
        ["2027-01-15", "2027-02-15"].map((asOf) =>
          config.resolve({
            key: "staff.compensation",
            scopes: [{ scopeType: "role_assignment", scopeId: a.id }],
            asOf: new Date(asOf)
          })
        )
      );
    });
    expect(resolved.map((r) => (r?.parsedValue as { amount: string }).amount)).toEqual([
      "500.25",
      "600.50"
    ]);
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.teamCompensation.update({ where: { id: rows[0].id }, data: { amount: "1" } })
      )
    ).rejects.toThrow("immutable");
    await expect(
      saveTeamCompensation(f.ctx, { ...base, expectedVersion: 2, effectiveFrom: "2026-01-01" }, deps())
    ).rejects.toBeInstanceOf(TeamConflictError);
  });
  it("masks unauthorized contacts and financial fields and returns only a staff member's own record", async () => {
    const f = await fixture(),
      a = await assignment(f);
    await compensationWriter(f);
    await saveTeamCompensation(
      f.ctx,
      {
        assignmentId: a.id,
        expectedVersion: 0,
        mode: "PER_JOB",
        amount: "500.25",
        currency: "MAD",
        effectiveFrom: "2027-01-01",
        reason: "Private compensation agreement"
      },
      deps()
    );
    const limited = actor(f.org, f.staffAccount.id, f.staff.id, new Set(["team_member:view"]));
    limited.authContext.scopes = [
      { organizationId: f.org, resourceType: "team_member", resourceId: f.staff.id }
    ];
    const own = await teamMember(
      limited,
      { personId: f.staff.id, from: "2027-01-01", until: "2027-03-01" },
      deps()
    );
    expect(own.profile.email).toBe("private@example.test");
    expect(JSON.stringify(own)).not.toContain("500.25");
    expect(own.wallet).toBeNull();
    expect(own.documents).toEqual([]);
    expect(own.properties).toEqual([]);
    const operator = actor(f.org, f.ctx.actorId, f.ctx.personId, new Set(["team_member:view"]));
    const masked = await teamMember(
      operator,
      { personId: f.staff.id, from: "2027-01-01", until: "2027-03-01" },
      deps()
    );
    expect(masked.profile.email).toBe("••••••");
    expect(masked.profile.phone).toBe("••••••");
    const configReader = actor(f.org, f.ctx.actorId, f.ctx.personId, new Set(["config_rule:view"]));
    expect(
      JSON.stringify(await getConfigAdminModel(configReader, {}, { db, requestId: randomUUID() }))
    ).not.toContain("500.25");
    const rate = await withTenant(db, f.org, (tx) =>
      tx.teamCompensation.findFirstOrThrow({ where: { assignmentId: a.id } })
    );
    await expect(
      retireConfigRuleVersion(
        f.ctx,
        {
          ruleId: rate.configRuleId,
          effectiveFrom: new Date("2027-02-01"),
          reason: "Attempt generic compensation retirement"
        },
        { db, requestId: randomUUID() }
      )
    ).rejects.toBeInstanceOf(ConfigAuthorizationError);
    expect((await teamDirectory(limited, {}, deps())).people.map((p) => p.id)).toEqual([f.staff.id]);
    await expect(
      teamMember(limited, { personId: f.ctx.personId, from: "2027-01-01", until: "2027-03-01" }, deps())
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
  });
  it("requires stored compensation authority even when the caller retains an old permission", async () => {
    const f = await fixture(), a = await assignment(f);
    await expect(saveTeamCompensation(f.ctx, { assignmentId: a.id, expectedVersion: 0, mode: "PER_JOB", amount: "500.25", currency: "MAD",
      effectiveFrom: "2027-01-01", reason: "Do not trust a stale caller grant" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    expect(await withTenant(db, f.org, tx => tx.teamCompensation.count({ where: { organizationId: f.org } }))).toBe(0);
  });
  it.each(["after_lock", "after_configuration", "after_guards"] as const)("rolls back compensation and its configuration when authority expires %s", async boundary => {
    const f = await fixture(), a = await assignment(f), grant = await compensationWriter(f);
    const snapshot = () => withTenant(db, f.org, async tx => ({
      rates: await tx.teamCompensation.findMany({ where: { organizationId: f.org }, orderBy: { id: "asc" } }),
      configuration: await tx.configRule.findMany({ where: { organizationId: f.org }, orderBy: { id: "asc" } }),
      audit: await tx.auditLog.findMany({ where: { organizationId: f.org }, orderBy: { id: "asc" } }),
      outbox: await tx.outboxEvent.findMany({ where: { organizationId: f.org }, orderBy: { id: "asc" } })
    }));
    const before = await snapshot(); let expired = false;
    const expire = async () => {
      if (expired) return;
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: grant.id }, data: { validTo: new Date("2020-01-02") } }));
      expired = true;
    };
    const originalLock = Reflect.get(TeamRepository.prototype, "lock") as TeamRepository["lock"];
    const originalConfig = Reflect.get(ConfigRuleRepository.prototype, "createVersion") as ConfigRuleRepository["createVersion"];
    const originalFlush = Reflect.get(TeamRepository.prototype, "flushGuards") as TeamRepository["flushGuards"];
    const spy = boundary === "after_lock" ? vi.spyOn(TeamRepository.prototype, "lock").mockImplementation(async function (this: TeamRepository, ...args) {
      await originalLock.apply(this, args); await expire();
    }) : boundary === "after_configuration" ? vi.spyOn(ConfigRuleRepository.prototype, "createVersion").mockImplementation(async function (this: ConfigRuleRepository, ...args) {
      const row = await originalConfig.apply(this, args); if (args[0].key === "staff.compensation") await expire(); return row;
    }) : vi.spyOn(TeamRepository.prototype, "flushGuards").mockImplementation(async function (this: TeamRepository, ...args) {
      await originalFlush.apply(this, args); await expire();
    });
    try {
      await expect(saveTeamCompensation(f.ctx, { assignmentId: a.id, expectedVersion: 0, mode: "PER_MONTH", amount: "4500.25", currency: "MAD",
        effectiveFrom: "2027-01-01", reason: "Retain no writes after a grant expires" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
      expect(expired).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally { spy.mockRestore(); }
  });
  it("applies stored compensation limits to the actual amount and effective date", async () => {
    const f = await fixture(), a = await assignment(f);
    await compensationWriter(f, { maxAmount: "500.25", timeWindow: { startsAt: "2027-01-01", endsAt: "2027-01-31" } });
    const input = { assignmentId: a.id, expectedVersion: 0, mode: "PER_JOB", amount: "500.25", currency: "MAD", effectiveFrom: "2027-01-01", reason: "Explicit contractual limit and date" };
    await expect(saveTeamCompensation(f.ctx, { ...input, amount: "500.26" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    await expect(saveTeamCompensation(f.ctx, { ...input, effectiveFrom: "2027-02-01" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const result = await saveTeamCompensation(f.ctx, input, deps());
    expect(await withTenant(db, f.org, tx => tx.teamCompensation.findUniqueOrThrow({ where: { id: result.id } }))).toMatchObject({ assignmentId: a.id, version: 1 });
  });
  it("retains the caller's compensation limit when stored authority is broader", async () => {
    const f = await fixture(), a = await assignment(f); await compensationWriter(f);
    const permission = new Set(["staff_compensation:create"]);
    const caller: IdentityActorContext = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: permission, assignments: [
      { scope: { organizationId: f.org }, permissions: permission, conditions: { maxAmount: "400.00" } }
    ] } };
    await expect(saveTeamCompensation(caller, { assignmentId: a.id, expectedVersion: 0, mode: "PER_HOUR", amount: "400.01", currency: "MAD",
      effectiveFrom: "2027-01-01", reason: "Never expand the caller restriction" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    expect(await withTenant(db, f.org, tx => tx.teamCompensation.count({ where: { organizationId: f.org } }))).toBe(0);
  });
  it("does not borrow a stored compensation grant for another actor", async () => {
    const f = await fixture(), a = await assignment(f); await compensationWriter(f);
    const stored = await authContextForAccount(f.org, f.account.id, deps());
    await expect(saveTeamCompensation({ ...f.ctx, actorId: f.staffAccount.id, authContext: { ...stored, personId: f.person.id } },
      { assignmentId: a.id, expectedVersion: 0, mode: "PER_JOB", amount: "500.25", currency: "MAD", effectiveFrom: "2027-01-01", reason: "Actor identity must match its authority" }, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
  });
  it("rejects leave conflicts in both directions and serializes competing leave decisions", async () => {
    const f = await fixture();
    const work = await task(f);
    const leave = await requestTeamAvailability(
      f.ctx,
      {
        personId: f.staff.id,
        kind: "LEAVE",
        startsOn: "2027-02-01",
        endsOn: "2027-02-04",
        reason: "Requested annual leave"
      },
      deps()
    );
    await expect(
      decideTeamAvailability(
        f.ctx,
        { id: leave.id, decision: "APPROVED", reason: "Approve annual leave" },
        deps()
      )
    ).rejects.toThrow("open tasks");
    await withTenant(db, f.org, (tx) =>
      tx.operationTask.update({ where: { id: work.id }, data: { state: "CANCELLED" } })
    );
    const other = await requestTeamAvailability(
      f.ctx,
      {
        personId: f.staff.id,
        kind: "UNAVAILABLE",
        startsOn: "2027-02-01",
        endsOn: "2027-02-03",
        reason: "Unavailable for work"
      },
      deps()
    );
    const decisions = await Promise.allSettled(
      [leave, other].map((l) =>
        decideTeamAvailability(
          f.ctx,
          { id: l.id, decision: "APPROVED", reason: "Approve time request" },
          deps()
        )
      )
    );
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(task(f)).rejects.toThrow("approved absence");
    await expect(
      decideTeamAvailability(
        actor(f.org, f.staffAccount.id, f.staff.id, new Set(["team_member:view"])),
        { id: other.id, decision: "APPROVED", reason: "Attempt self approval" },
        deps()
      )
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
  });
  it("derives workload from real scoped tasks and completed outcomes", async () => {
    const f = await fixture();
    await task(f);
    const done = await task(f, "2027-02-03");
    await withTenant(db, f.org, (tx) =>
      tx.operationTask.update({
        where: { id: done.id },
        data: { state: "COMPLETED", completedAt: new Date("2027-02-03") }
      })
    );
    const detail = await teamMember(
      f.ctx,
      { personId: f.staff.id, from: "2027-02-01", until: "2027-03-01" },
      deps()
    );
    expect(detail.tasks).toHaveLength(2);
    expect(detail.metrics?.completed).toBe(1);
    expect(detail.metrics?.open).toBe(1);
    const denied = actor(f.org, f.staffAccount.id, f.staff.id, new Set(["team_member:view"]));
    expect(
      (
        await teamMember(
          denied,
          { personId: f.staff.id, from: "2027-02-01", until: "2027-03-01" },
          deps()
        )
      ).tasks
    ).toHaveLength(0);
  });
  it("paginates the directory with a bounded query count", async () => {
    const f = await fixture();
    await withTenant(db, f.org, (tx) =>
      tx.person.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
          organizationId: f.org,
          displayName: `Directory member ${i}`
        }))
      })
    );
    const observed = new PrismaClient({
      datasourceUrl: applicationUrl,
      log: [{ emit: "event", level: "query" }]
    });
    let queries = 0;
    observed.$on("query", () => {
      queries++;
    });
    try {
      const first = await teamDirectory(f.ctx, { page: 1 }, { db: observed });
      expect(first.people).toHaveLength(25);
      expect(first.total).toBe(32);
      expect(queries).toBeLessThanOrEqual(6);
      const second = await teamDirectory(f.ctx, { page: 2 }, { db: observed });
      expect(second.people).toHaveLength(7);
      expect(new Set([...first.people, ...second.people].map((p) => p.id)).size).toBe(32);
    } finally {
      await observed.$disconnect();
    }
  });
  it("applies region and city scopes to property assignments before returning staff and workload", async () => {
    const f = await fixture();
    const geography = await withTenant(db, f.org, async (tx) => {
      const region = await tx.region.create({
        data: { organizationId: f.org, name: "Authorized region" }
      });
      const city = await tx.city.create({
        data: { organizationId: f.org, regionId: region.id, name: "Authorized city" }
      });
      await tx.property.update({
        where: { id: f.property.id },
        data: { regionId: region.id, cityId: city.id }
      });
      return { region, city };
    });
    await assignTeamRole(
      f.ctx,
      {
        personId: f.staff.id,
        roleId: f.role.id,
        scopeType: "property",
        scopeId: f.property.id,
        validFrom: "2020-01-01",
        validTo: null,
        assignedToMe: false,
        reason: "Authorized geographic assignment"
      },
      deps()
    );
    await task(f);
    for (const scope of [
      { scopeType: "region" as const, scopeId: geography.region.id },
      { scopeType: "city" as const, scopeId: geography.city.id }
    ]) {
      const manager = actor(
        f.org,
        f.ctx.actorId,
        f.ctx.personId,
        new Set(["team_member:view", "task:view"])
      );
      manager.authContext.scopes = [{ organizationId: f.org, ...scope }];
      expect((await teamDirectory(manager, {}, deps())).people.map((p) => p.id)).toEqual([f.staff.id]);
      const detail = await teamMember(
        manager,
        { personId: f.staff.id, from: "2027-02-01", until: "2027-03-01" },
        deps()
      );
      expect(detail.tasks).toHaveLength(1);
      expect(detail.assignments).toHaveLength(1);
      expect(detail.profile.email).toBe("••••••");
    }
  });
  it("creates a dedicated custody account without linking an organization bank account", async () => {
    const f = await fixture();
    const bank = await withTenant(db, f.org, (tx) =>
      tx.ledgerAccount.create({
        data: {
          organizationId: f.org,
          code: "BANK",
          name: "Organization bank",
          accountType: "ASSET",
          normalSide: "DEBIT"
        }
      })
    );
    await expect(
      linkTeamWallet(
        f.ctx,
        { personId: f.staff.id, ledgerAccountId: bank.id, reason: "Attempt bank account link" },
        deps()
      )
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    await linkTeamWallet(
      f.ctx,
      {
        personId: f.staff.id,
        accountName: "Staff cash custody",
        reason: "Create dedicated staff custody wallet"
      },
      deps()
    );
    const link = await withTenant(db, f.org, (tx) =>
      tx.teamWallet.findFirstOrThrow({
        where: { personId: f.staff.id },
        include: { ledgerAccount: true }
      })
    );
    expect(link.ledgerAccount.accountType).toBe("STAFF_WALLET");
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.ledgerAccount.update({ where: { id: link.ledgerAccountId }, data: { normalSide: "CREDIT" } })
      )
    ).rejects.toThrow("immutable");
  });
  it("serializes offboarding against a concurrent task assignment", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      offboardTeamMember(f.ctx, { personId: f.staff.id, reason: "Concurrent staff departure" }, deps()),
      task(f)
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = await withTenant(db, f.org, async (tx) => ({
      person: await tx.person.findUniqueOrThrow({ where: { id: f.staff.id } }),
      open: await tx.operationTask.count({
        where: { organizationId: f.org, assignedToPersonId: f.staff.id, state: "PLANNED" }
      })
    }));
    expect(Boolean(current.person.archivedAt) && current.open > 0).toBe(false);
  });
  it("blocks every deactivation path until all tasks and every wallet currency clear", async () => {
    const f = await fixture();
    const work = await task(f);
    await expect(
      offboardTeamMember(f.ctx, { personId: f.staff.id, reason: "Staff departure request" }, deps())
    ).rejects.toBeInstanceOf(TeamConflictError);
    await expect(deactivateAccount(f.ctx, f.staffAccount.id, deps())).rejects.toThrow("obligations");
    await withTenant(db, f.org, (tx) =>
      tx.operationTask.update({ where: { id: work.id }, data: { state: "CANCELLED" } })
    );
    const [wallet, offset] = await withTenant(db, f.org, async (tx) =>
      Promise.all(
        ["STAFF_WALLET", "WALLET_OFFSET"].map((code) =>
          tx.ledgerAccount.create({
            data: {
              organizationId: f.org,
              code,
              name: code,
              accountType: code === "STAFF_WALLET" ? "STAFF_WALLET" : "ASSET",
              normalSide: "DEBIT"
            }
          })
        )
      )
    );
    await linkTeamWallet(
      f.ctx,
      { personId: f.staff.id, ledgerAccountId: wallet.id, reason: "Link staff cash movement account" },
      deps()
    );
    async function post(side: "DEBIT" | "CREDIT", currency: string, ref: string) {
      await withTenant(db, f.org, (tx) =>
        tx.financialTransaction.create({
          data: {
            organizationId: f.org,
            reference: ref,
            occurredAt: new Date(),
            postings: {
              create: [
                { organizationId: f.org, ledgerAccountId: wallet.id, amount: "100.50", currency, side },
                {
                  organizationId: f.org,
                  ledgerAccountId: offset.id,
                  amount: "100.50",
                  currency,
                  side: side === "DEBIT" ? "CREDIT" : "DEBIT"
                }
              ]
            }
          }
        })
      );
    }
    await post("DEBIT", "MAD", "ADVANCE-MAD");
    await post("CREDIT", "EUR", "RETURN-EUR");
    await expect(
      offboardTeamMember(f.ctx, { personId: f.staff.id, reason: "Staff departure request" }, deps())
    ).rejects.toBeInstanceOf(TeamConflictError);
    await post("CREDIT", "MAD", "RETURN-MAD");
    await post("DEBIT", "EUR", "ADVANCE-EUR");
    await offboardTeamMember(
      f.ctx,
      { personId: f.staff.id, reason: "Confirmed staff departure" },
      deps()
    );
    const staff = await withTenant(db, f.org, (tx) =>
      tx.userAccount.findUniqueOrThrow({ where: { id: f.staffAccount.id } })
    );
    expect(staff.status).toBe("DEACTIVATED");
    await expect(task(f)).rejects.toThrow("inactive");
    expect(
      await withTenant(db, f.org, (tx) => tx.posting.count({ where: { organizationId: f.org } }))
    ).toBe(8);
  });
  it("protects encrypted documents, expiry reminders and revocable access without exposing storage keys", async () => {
    const f = await fixture();
    let stored = new Uint8Array();
    let storedType = "";
    let downloadRequests = 0;
    const storage: PrivateDocumentStorage = {
      createSignedUploadUrl: () => Promise.resolve({ url: "https://private.example.test/upload" }),
      createSignedDownloadUrl: (input) =>
        Promise.resolve({
          url: `https://private.example.test/download?expires=${input.expiresInSeconds}`
        })
    };
    const transport = ((_url, init) => {
      if (init?.method === "PUT") {
        stored = new Uint8Array(init.body as Uint8Array);
        storedType = new Headers(init.headers).get("Content-Type")!;
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      downloadRequests++;
      return Promise.resolve(new Response(new Uint8Array(stored), { status: 200 }));
    }) as typeof fetch;
    const bytes = Buffer.from("%PDF-1.7\nprivate staff document");
    const document = await uploadTeamDocument(
      f.ctx,
      {
        personId: f.staff.id,
        title: "Staff agreement",
        kind: "CONTRACT",
        expiresOn: "2027-02-28",
        contentType: "application/pdf",
        size: bytes.length,
        reason: "Signed employment agreement"
      },
      bytes,
      { db, storage, transport }
    );
    expect(storedType).toBe("application/octet-stream");
    expect(Buffer.from(stored).includes(bytes)).toBe(false);
    const detail = await teamMember(
      f.ctx,
      { personId: f.staff.id, from: "2027-02-01", until: "2027-03-01" },
      deps()
    );
    expect(detail.documents.map((d) => d.id)).toEqual([document.id]);
    expect(JSON.stringify(detail)).not.toContain("/staff/");
    const limited = actor(f.org, f.staffAccount.id, f.staff.id, new Set(["team_member:view"]));
    await expect(
      downloadTeamDocument(limited, document.id, { db, storage, transport })
    ).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const other = await fixture();
    await expect(
      downloadTeamDocument(other.ctx, document.id, { db, storage, transport })
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    expect(downloadRequests).toBe(0);
    const downloaded = await downloadTeamDocument(f.ctx, document.id, { db, storage, transport });
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.contentType).toBe("application/pdf");
    stored[stored.length - 1] ^= 1;
    await expect(downloadTeamDocument(f.ctx, document.id, { db, storage, transport })).rejects.toThrow();
    stored[stored.length - 1] ^= 1;
    await withTenant(db, f.org, async (tx) => {
      const permission = await tx.permission.findFirstOrThrow({
        where: { organizationId: f.org, key: "staff_document:view" }
      });
      const role = await tx.role.create({
        data: {
          organizationId: f.org,
          key: "document_custodian",
          name: "Document custodian",
          rolePermissions: { create: { organizationId: f.org, permissionId: permission.id } }
        }
      });
      await tx.roleAssignment.create({
        data: {
          organizationId: f.org,
          personId: f.staff.id,
          userAccountId: f.staffAccount.id,
          roleId: role.id,
          scopeType: "organization"
        }
      });
      await new ConfigRuleRepository(tx, f.org).createVersion({
        key: "notification.routing.staff_document_expiring",
        scopeType: "organization",
        effectiveFrom: new Date("2020-01-01"),
        reason: "Route expiry reminders to authorized custodian",
        value: { roles: [role.id], people: [], assigned: false, channels: ["in_app"] }
      });
    });
    await scheduleTeamDocumentReminders(f.org, { db, now: new Date("2027-02-21T12:00:00Z") });
    await scheduleTeamDocumentReminders(f.org, { db, now: new Date("2027-02-21T12:00:00Z") });
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.outboxEvent.count({
          where: {
            organizationId: f.org,
            idempotencyKey: { startsWith: `staff-document:${document.id}:` }
          }
        })
      )
    ).toBe(1);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.notification.count({
          where: { organizationId: f.org, recipientId: f.staffAccount.id, targetId: document.id }
        })
      )
    ).toBe(1);
    const inboxActor = {
      organizationId: f.org,
      accountId: f.staffAccount.id,
      authContext: ownNotificationContext(actor(f.org, f.staffAccount.id, f.staff.id, new Set(["staff_document:view"])).authContext, f.staffAccount.id)
    };
    const inbox = await getNotificationPage(inboxActor, {}, { db });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({kind:"staff_document_expiring",available:true});
    await archiveTeamDocument(f.ctx, { id: document.id, reason: "Superseded by new agreement" }, deps());
    expect((await getNotificationPage(inboxActor, {}, { db })).items[0].available).toBe(false);
    const requestsBeforeArchive = downloadRequests;
    await expect(
      downloadTeamDocument(f.ctx, document.id, { db, storage, transport })
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    expect(downloadRequests).toBe(requestsBeforeArchive);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: { organizationId: f.org, resourceId: document.id, action: "team.document.download" }
        })
      )
    ).toBe(1);
  });

  it.skipIf(!url)("own field wallet derives every currency from immutable movements and writes only its read audit", async () => {
    const f = await ownWalletFixture(); await f.post("DEBIT", "1500.00", "MAD", "Advance");
    await f.post("CREDIT", "850.00", "MAD", "Property groceries"); await f.post("CREDIT", "200.00", "MAD", "Company supplies");
    await f.post("DEBIT", "75.25", "EUR", "EUR advance");
    const before = await withTenant(db, f.org, tx => tx.financialTransaction.count());
    const result = await ownFieldWallet(f.reader, {}, deps());
    expect(result.balances.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([{ amount: "75.25", currency: "EUR" }, { amount: "450.00", currency: "MAD" }]);
    expect(result.movements).toHaveLength(4); expect(result.compensationVisible).toBe(false); expect(result.compensationTerms).toEqual([]);
    expect(result).not.toHaveProperty("ledgerAccountId"); expect(result).not.toHaveProperty("personId");
    await withTenant(db, f.org, async tx => {
      expect(await tx.financialTransaction.count()).toBe(before);
      expect(await tx.auditLog.count({ where: { action: "team.wallet.view.own", actorId: f.staffAccount.id } })).toBe(1);
    });
  });

  it.skipIf(!url)("own field wallet denies operational permissions, another wallet scope and forged actor/person/tenant context", async () => {
    const f = await ownWalletFixture(); await f.post("DEBIT", "250.00", "MAD", "Private own advance");
    const operational = actor(f.org, f.staffAccount.id, f.staff.id, new Set(["task:view", "task:edit"]));
    await expect(ownFieldWallet(operational, {}, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    const wrongScope: IdentityActorContext = { ...f.reader, authContext: { ...f.reader.authContext, scopes: [{ organizationId: f.org, scopeType: "wallet", scopeId: randomUUID() }] } };
    await expect(ownFieldWallet(wrongScope, {}, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    for (const changed of [{ actorId: f.account.id }, { personId: f.person.id }, { organizationId: randomUUID() }])
      await expect(ownFieldWallet({ ...f.reader, ...changed }, {}, deps())).rejects.toBeInstanceOf(IdentityAuthorizationError);
    await expect(ownFieldWallet(f.reader, { personId: f.person.id }, deps())).rejects.toThrow();
    await expect(ownFieldWallet(f.reader, { page: 0 }, deps())).rejects.toThrow();
    const other = await ownWalletFixture(); await other.post("DEBIT", "999.00", "MAD", "Another organization's cash");
    expect((await ownFieldWallet(f.reader, {}, deps())).balances).toEqual([{ amount: "250.00", currency: "MAD" }]);
  });

  it.skipIf(!url)("own field wallet pages posted history without exposing another person's ledger", async () => {
    const f = await ownWalletFixture(); for (let index = 0; index < 30; index++) await f.post("DEBIT", "1.01", "MAD", `Own movement ${index}`);
    const first = await ownFieldWallet(f.reader, { page: 1 }, deps()), second = await ownFieldWallet(f.reader, { page: 2 }, deps());
    expect(first.movements).toHaveLength(25); expect(first.hasNext).toBe(true); expect(second.movements).toHaveLength(5); expect(second.hasNext).toBe(false);
    expect(new Set([...first.movements, ...second.movements].map(row => row.id)).size).toBe(30);
    expect(first.balances).toEqual([{ amount: "30.30", currency: "MAD" }]); expect(second.balances).toEqual(first.balances);
  });

  it.skipIf(!url)("own field wallet keeps compensation independently permissioned and displays only effective terms", async () => {
    const f = await ownWalletFixture(); await compensationWriter(f); const assigned = await assignTeamRole(f.ctx, { personId: f.staff.id, roleId: f.role.id,
      scopeType: "property", scopeId: f.property.id, validFrom: "2020-01-01", validTo: null, assignedToMe: true, reason: "Explicit current staff assignment" }, deps());
    await saveTeamCompensation(f.ctx, { assignmentId: assigned.id, expectedVersion: 0, mode: "PER_MONTH", amount: "3500.00", currency: "MAD",
      effectiveFrom: "2021-01-01", reason: "Current authorized compensation terms" }, deps());
    await saveTeamCompensation(f.ctx, { assignmentId: assigned.id, expectedVersion: 1, mode: "PER_MONTH", amount: "4000.00", currency: "MAD",
      effectiveFrom: "2077-01-01", reason: "Future terms must not replace the current rate" }, deps());
    const hidden = await ownFieldWallet(f.reader, {}, deps()); expect(hidden.compensationVisible).toBe(false); expect(hidden.compensationTerms).toEqual([]);
    const finance: IdentityActorContext = { ...f.reader, authContext: { ...f.reader.authContext, permissions: new Set(["wallet:view", "staff_compensation:view"]),
      assignments: [{ scope: f.reader.authContext.scopes[0], permissions: new Set(["wallet:view"]) },
        { scope: { organizationId: f.org, scopeType: "property", scopeId: f.property.id }, permissions: new Set(["staff_compensation:view"]) }] } };
    const visible = await ownFieldWallet(finance, {}, deps()); expect(visible.compensationVisible).toBe(true);
    expect(visible.compensationTerms).toHaveLength(1); expect(visible.compensationTerms[0]).toMatchObject({ mode: "PER_MONTH", amount: "3500", currency: "MAD" });
  });

  it.skipIf(!url)("own field wallet pins balance and history to one PostgreSQL snapshot during a concurrent posting", async () => {
    const f = await ownWalletFixture(); await f.post("DEBIT", "10.00", "MAD", "Before snapshot");
    let release!: () => void, captured!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { captured = resolve; });
    const runner: TenantTransactionRunner = { $transaction: (work, options) => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT txid_current_snapshot()::text AS snapshot`; captured(); await held; return work(tx);
    }, options) };
    const reading = ownFieldWallet(f.reader, {}, { db: runner });
    try {
      await Promise.race([ready, reading.then(() => { throw new Error("Wallet read finished before the snapshot barrier"); })]);
      await f.post("DEBIT", "25.00", "MAD", "Concurrent posted advance"); release();
      const snapshot = await reading; expect(snapshot.balances).toEqual([{ amount: "10.00", currency: "MAD" }]); expect(snapshot.movements).toHaveLength(1);
      const current = await ownFieldWallet(f.reader, {}, deps()); expect(current.balances).toEqual([{ amount: "35.00", currency: "MAD" }]); expect(current.movements).toHaveLength(2);
    } finally { release(); await reading; }
  });
});

async function ownWalletFixture() {
  const f = await fixture();
  const [wallet, offset] = await withTenant(db, f.org, tx => Promise.all(["STAFF_WALLET", "WALLET_OFFSET"].map(code => tx.ledgerAccount.create({ data: {
    organizationId: f.org, code, name: code, accountType: code === "STAFF_WALLET" ? "STAFF_WALLET" : "ASSET", normalSide: "DEBIT",
  } }))));
  await linkTeamWallet(f.ctx, { personId: f.staff.id, ledgerAccountId: wallet.id, reason: "Link the dedicated employee wallet" }, deps());
  const link = await withTenant(db, f.org, tx => tx.teamWallet.findFirstOrThrow({ where: { personId: f.staff.id } }));
  const reader = actor(f.org, f.staffAccount.id, f.staff.id, new Set(["wallet:view"]));
  reader.authContext.scopes = [{ organizationId: f.org, scopeType: "wallet", scopeId: link.id }];
  async function post(side: "DEBIT" | "CREDIT", amount: string, currency: string, description: string) {
    await withTenant(db, f.org, tx => tx.financialTransaction.create({ data: { organizationId: f.org, reference: randomUUID(), occurredAt: new Date(), description,
      postings: { create: [{ organizationId: f.org, ledgerAccountId: wallet.id, side, amount, currency },
        { organizationId: f.org, ledgerAccountId: offset.id, side: side === "DEBIT" ? "CREDIT" : "DEBIT", amount, currency }] } } }));
  }
  return { ...f, reader, wallet, offset, post };
}
