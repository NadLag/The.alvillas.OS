import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { advisoryTransactionLock } from "@/platform/db/advisory-lock-repository";
import { prisma } from "@/platform/db/client";
import { assertOrganizationId, withTenant, type TenantTransaction } from "@/platform/db/tenant";
import {
  canUseHousehold, householdAuthority, householdIdSchema, householdMemberSchema, presentPersonal, type HouseholdIdentity
} from "../domain/household-access";

export class PersonalAccessDenied extends Error {}
export class PersonalConflict extends Error {}

function personalContext(tx: TenantTransaction, identity: HouseholdIdentity, householdId?: string) {
  return tx.$executeRaw(Prisma.sql`
    SELECT set_config('app.personal_actor_id', ${identity.accountId}, true),
           set_config('app.personal_household_id', ${householdId ?? ""}, true)
  `);
}

async function activeAccount(tx: TenantTransaction, identity: HouseholdIdentity) {
  const account = await tx.userAccount.findUnique({
    where: { organizationId_id: { organizationId: identity.organizationId, id: identity.accountId } },
    select: { status: true }
  });
  return account?.status === "ACTIVE";
}

async function nextPersonalId(tx: TenantTransaction) {
  const [{ id }] = await tx.$queryRaw<[{ id: string }]>(Prisma.sql`SELECT app_uuid_v7()::text AS id`);
  return id;
}

export class HouseholdRepository {
  constructor(private readonly db = prisma) {}

  async listHouseholds(identity: HouseholdIdentity) {
    assertOrganizationId(identity.accountId);
    const ids = await withTenant(this.db, identity.organizationId, async (tx) => {
      await personalContext(tx, identity);
      if (!await activeAccount(tx, identity)) throw new PersonalAccessDenied();
      return tx.personalMember.findMany({
        where: { organizationId: identity.organizationId, accountId: identity.accountId, revokedAt: null },
        orderBy: { householdId: "asc" },
        select: { householdId: true }
      });
    });
    return ids.map(({ householdId }) => householdId);
  }

  async scoped<T>(identity: HouseholdIdentity, householdId: string, work: (scope: HouseholdScope) => Promise<T>) {
    assertOrganizationId(identity.accountId);
    householdIdSchema.parse(householdId);
    return withTenant(this.db, identity.organizationId, async (tx) => {
      await personalContext(tx, identity, householdId);
      await advisoryTransactionLock(tx, `personal:${identity.organizationId}:${householdId}`);
      if (!await activeAccount(tx, identity)) throw new PersonalAccessDenied();
      const member = await tx.personalMember.findUnique({
        where: { organizationId_householdId_accountId: { organizationId: identity.organizationId, accountId: identity.accountId, householdId } }
      });
      const context = householdAuthority(identity, member);
      if (!canUseHousehold(context, householdId, "household")) throw new PersonalAccessDenied();
      return work(new HouseholdScope(tx, identity, householdId, context));
    });
  }

  /** Provision from the operator CLI using an explicit active identity. */
  async provision(identity: HouseholdIdentity, name: string, displayName: string) {
    assertOrganizationId(identity.accountId);
    const member = householdMemberSchema.parse({ accountId: identity.accountId, displayName, isChild: false, grants: [] });
    const label = name.trim();
    if (!label || label.length > 120) throw new PersonalConflict();
    return withTenant(this.db, identity.organizationId, async (tx) => {
      await advisoryTransactionLock(tx, `personal-provision:${identity.organizationId}:${identity.accountId}`);
      await personalContext(tx, identity);
      if (!await activeAccount(tx, identity)) throw new PersonalAccessDenied();
      const existing = await tx.personalMember.findFirst({
        where: { organizationId: identity.organizationId, accountId: identity.accountId, isSteward: true }, select: { householdId: true }
      });
      if (existing) {
        await personalContext(tx, identity, existing.householdId);
        const household = await tx.personalHousehold.findUniqueOrThrow({
          where: { organizationId_id: { organizationId: identity.organizationId, id: existing.householdId } }
        });
        if (household.name !== label) throw new PersonalConflict();
        return existing.householdId;
      }
      const id = await nextPersonalId(tx);
      await personalContext(tx, identity, id);
      await tx.personalHousehold.create({ data: { organizationId: identity.organizationId, id, name: label } });
      const steward = await tx.personalMember.create({
        data: { ...member, organizationId: identity.organizationId, householdId: id, isSteward: true }
      });
      const scope = new HouseholdScope(tx, identity, id, householdAuthority(identity, steward));
      await scope.audit("personal.household_provisioned", "personal_household", id);
      return id;
    });
  }
}

export class HouseholdScope {
  constructor(
    readonly tx: TenantTransaction,
    readonly identity: HouseholdIdentity,
    readonly id: string,
    readonly authority: ReturnType<typeof householdAuthority>
  ) {}

  nextId() {
    return nextPersonalId(this.tx);
  }

  get key() {
    return { organizationId: this.identity.organizationId, householdId: this.id };
  }

  require(...args: [area: Parameters<typeof canUseHousehold>[2], action?: "view" | "edit"]) {
    if (!canUseHousehold(this.authority, this.id, ...args)) throw new PersonalAccessDenied();
  }

  async name() {
    const { name } = await this.tx.personalHousehold.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: this.identity.organizationId, id: this.id } },
      select: { name: true }
    });
    return presentPersonal(this.authority, this.id, "household", { name }).name;
  }

  async members(after?: string) {
    this.require("members");
    const rows = await this.tx.personalMember.findMany({
      where: { ...this.key, ...(after ? { accountId: { gt: after } } : {}) },
      orderBy: { accountId: "asc" }, take: 51,
      select: { accountId: true, displayName: true, isChild: true, isSteward: true, grants: true, revokedAt: true }
    });
    return {
      items: rows.slice(0, 50).map((row) => presentPersonal(this.authority, this.id, "members", row)),
      next: rows.length > 50 ? rows[49].accountId : undefined
    };
  }

  async setMember(input: unknown) {
    this.require("members", "edit");
    const change = householdMemberSchema.parse(input);
    if (!await activeAccount(this.tx, { ...this.identity, accountId: change.accountId })) throw new PersonalConflict();
    const key = { ...this.key, accountId: change.accountId };
    const previous = await this.tx.personalMember.findUnique({ where: { organizationId_householdId_accountId: key } });
    if (previous?.isSteward) throw new PersonalConflict();
    if (previous && previous.revokedAt === null && previous.displayName === change.displayName && previous.isChild === change.isChild
      && JSON.stringify(previous.grants) === JSON.stringify(change.grants)) return;
    await this.tx.personalMember.upsert({
      where: { organizationId_householdId_accountId: key },
      create: { ...key, ...change },
      update: { ...change, revokedAt: null }
    });
    await this.audit("personal.member_changed", "personal_member", change.accountId,
      previous && { isChild: previous.isChild, grants: previous.grants, revoked: previous.revokedAt !== null },
      { isChild: change.isChild, grants: change.grants, revoked: false });
  }

  async revokeMember(accountId: string) {
    this.require("members", "edit");
    householdIdSchema.parse(accountId);
    const key = { ...this.key, accountId };
    const previous = await this.tx.personalMember.findUnique({
      where: { organizationId_householdId_accountId: key },
      select: { isSteward: true, isChild: true, grants: true, revokedAt: true }
    });
    if (!previous || previous.isSteward || previous.revokedAt) return;
    await this.tx.personalMember.update({
      where: { organizationId_householdId_accountId: key },
      data: { revokedAt: new Date(), grants: [] }
    });
    await this.audit("personal.member_revoked", "personal_member", accountId,
      { isChild: previous.isChild, grants: previous.grants, revoked: false }, { revoked: true });
  }

  async auditTrail(after?: { occurredAt: Date; id: string }) {
    this.require("audit");
    const rows = await this.tx.personalAuditEvent.findMany({
      where: { ...this.key, ...(after ? { OR: [{ occurredAt: { lt: after.occurredAt } }, {
        occurredAt: after.occurredAt, id: { lt: after.id }
      }] } : {}) },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51,
      select: { id: true, action: true, occurredAt: true, actorId: true, resourceId: true }
    });
    return {
      items: rows.slice(0, 50).map((row) => presentPersonal(this.authority, this.id, "audit", row)),
      next: rows.length > 50 ? { id: rows[49].id, occurredAt: rows[49].occurredAt } : undefined
    };
  }

  audit(action: string, resourceType: string, resourceId: string | null, before?: unknown, after?: unknown, reason?: string) {
    return writeAuditEvent({ auditLog: { create: ({ data }) => {
      const { propertyScopeId, actorId, ...event } = data;
      if (propertyScopeId !== null || actorId !== this.identity.accountId) throw new PersonalAccessDenied();
      return this.tx.personalAuditEvent.create({ data: { ...event, householdId: this.id, actorId } });
    } } }, {
      organizationId: this.identity.organizationId, actorId: this.identity.accountId,
      action, resourceType, resourceId, before, after, reason, requestId: randomUUID(), occurredAt: new Date()
    });
  }
}
