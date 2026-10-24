import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { authorize, type AuthAssignment, type Scope } from "@/platform/authz/authorize";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { fieldPullInputSchema, fieldPullResultSchema, type FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const anchor = () => new Date(Date.now() + 1000);
const day = "2026-01-10";
const propertyData = (org: string, extra = {}) => ({ organizationId: org, name: "Offline pull villa", addressLine1: "Operational address",
  city: "Marrakech", region: "Marrakech-Safi", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [], ...extra });
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Field pull integration", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Pull worker" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const other = await tx.person.create({ data: { organizationId: org, displayName: "Other worker" } });
    const otherAccount = await tx.userAccount.create({ data: { organizationId: org, personId: other.id } });
    const property = await tx.property.create({ data: propertyData(org) });
    const ctx: ReservationActorContext = { organizationId: org, actorId: account.id, personId: person.id,
      authContext: { organizationId: org, userAccountId: account.id, personId: person.id, permissions: new Set(["task:view", "task:edit"]), scopes: [{ organizationId: org }] } };
    return { org, person, account, property, other, otherAccount, ctx };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function task(f: Fixture, extra: Partial<Prisma.OperationTaskUncheckedCreateInput> = {}) {
  return withTenant(db, f.org, tx => tx.operationTask.create({ data: {
    organizationId: f.org, propertyId: f.property.id, assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id,
    type: "INSPECTION", state: "ASSIGNED", dueDate: new Date(day), titleTranslations: { en: "Inspect", fr: "Inspecter", ar: "تفقد" }, idempotencyKey: randomUUID(), ...extra,
    checklistItems: { create: { organizationId: f.org, key: "ready", labelTranslations: { en: "Ready", fr: "Prêt", ar: "جاهز" }, sortOrder: 0 } }
  } }));
}
const input = (f: Fixture, extra = {}) => fieldPullInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, ...extra });
const pull = (f: Fixture, extra = {}, now = anchor()) => pullFieldWork(f.ctx, input(f, extra), { db, now });
const known = (rows: FieldWorkSnapshot[]) => rows.map(({ id, revision }) => ({ id, revision }));
const update = <T>(f: Fixture, work: (tx: TenantTransaction) => Promise<T>) => withTenant(db, f.org, work);

describe("field pull on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Local TEST_DATABASE_URL required for field pull integration");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const app = new URL(url); app.username = "alvillas_ops_tests"; app.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: app.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("paginates over 500 properties without duplicates, hides financial/contact data and omits unchanged snapshots", async () => {
    const f = await fixture(), ids = Array.from({ length: 505 }, () => randomUUID());
    await update(f, async tx => {
      await tx.property.createMany({ data: ids.map((id, index) => propertyData(f.org, { id, name: `Villa ${index}` })) });
      await tx.operationTask.createMany({ data: ids.map(propertyId => ({ organizationId: f.org, propertyId,
        assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id, state: "ASSIGNED", type: "INSPECTION",
        dueDate: new Date(day), titleTranslations: { en: "Inspect" }, idempotencyKey: randomUUID() })) });
    });
    let cursor: string | undefined; const rows: FieldWorkSnapshot[] = [], now = anchor(); let pages = 0;
    do {
      const result = fieldPullResultSchema.parse(await pull(f, { cursor }, now));
      expect(result.tasks.length).toBeLessThanOrEqual(50); rows.push(...result.tasks); cursor = result.next_cursor ?? undefined;
      expect(++pages).toBeLessThan(15);
    } while (cursor);
    expect(rows).toHaveLength(505); expect(new Set(rows.map(row => row.id)).size).toBe(505);
    expect(new Set(rows.map(row => row.propertyId))).toEqual(new Set(ids));
    for (const row of rows) for (const key of ["guestEmail", "guestPhone", "financialSnapshot", "commission", "balance", "organizationId"]) expect(row).not.toHaveProperty(key);
    const unchanged = await pull(f, { known_tasks: known(rows.slice(0, 50)) }, now);
    expect(unchanged.tasks).toEqual([]); expect(unchanged.known_changes).toEqual([]); expect(unchanged.tombstones).toEqual([]);
  });

  it("revalidates known records and removes reassigned, archived, terminal or inaccessible work without exposing foreign tenants", async () => {
    const f = await fixture(), foreign = await fixture(), active = await task(f), reassigned = await task(f), archived = await task(f), cancelled = await task(f), alien = await task(foreign);
    const initial = await pull(f);
    await update(f, async tx => {
      await tx.operationTask.update({ where: { id: reassigned.id }, data: { assignedToUserAccountId: f.otherAccount.id, assignedToPersonId: f.other.id } });
      await tx.operationTask.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
      await tx.operationTask.update({ where: { id: cancelled.id }, data: { state: "CANCELLED" } });
    });
    const result = await pull(f, { known_tasks: [...known(initial.tasks), { id: alien.id, revision: null }] });
    expect(result.tasks.map(row => row.id)).not.toContain(alien.id);
    expect(result.tombstones.sort()).toEqual([reassigned.id, archived.id, cancelled.id, alien.id].sort());
    expect(result.tombstones).not.toContain(active.id);
    expect(await update(f, tx => tx.operationTask.count({ where: { organizationId: foreign.org } }))).toBe(0);
    const role = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("detects linked metadata and checklist corrections and returns only current scoped guest projections", async () => {
    const f = await fixture();
    const reservation = await update(f, async tx => {
      const guest = await tx.guestRecord.create({ data: { organizationId: f.org, displayName: "Private guest", email: "private@example.test", phone: "+212600000000" } });
      return tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, guestId: guest.id, reference: randomUUID(), source: "DIRECT",
        guestName: "Private guest", guestEmail: "private@example.test", guestPhone: "+212600000000", checkIn: new Date(day), checkOut: new Date("2026-01-12"), nights: 2, idempotencyKey: randomUUID() } });
    });
    const job = await task(f, { reservationId: reservation.id }), initial = await pull(f);
    expect(initial.tasks[0]).not.toHaveProperty("guestName");
    await update(f, tx => tx.property.update({ where: { id: f.property.id }, data: { name: "Renamed villa" } }));
    const linked = await pull(f, { known_tasks: known(initial.tasks) });
    expect(linked.known_changes[0]).toMatchObject({ id: job.id, propertyName: "Renamed villa" });
    expect(linked.known_changes[0].revision).not.toBe(initial.tasks[0].revision);
    await update(f, async tx => {
      await tx.operationTaskChecklistItem.updateMany({ where: { taskId: job.id }, data: { completedAt: new Date(), completedByUserAccountId: f.account.id, completedByPersonId: f.person.id } });
      await tx.operationTask.update({ where: { id: job.id }, data: { version: { increment: 1 } } });
    });
    const progress = await pull(f, { known_tasks: known(linked.known_changes) });
    expect(progress.known_changes[0].checklistItems[0].completed).toBe(true);
    f.ctx.authContext.permissions = new Set(["task:view", "task:edit", "guest:view"]);
    f.ctx.authContext.assignments = [
      { scope: { organizationId: f.org }, permissions: new Set(["task:view", "task:edit"]) },
      { scope: { organizationId: f.org, scopeType: "property", scopeId: f.property.id }, permissions: new Set(["guest:view"]) }
    ];
    expect((await pull(f)).tasks[0].guestName).toBe("Private guest");
    f.ctx.authContext.assignments = [f.ctx.authContext.assignments[0], { ...f.ctx.authContext.assignments[1], scope: { organizationId: f.org, scopeType: "property", scopeId: randomUUID() } }];
    const masked = await pull(f); expect(masked.tasks[0]).not.toHaveProperty("guestName");
    expect(JSON.stringify(masked)).not.toContain("private@example.test"); expect(JSON.stringify(masked)).not.toContain("+212600000000");
  });

  it("uses each property's server calendar and finds newly eligible jobs without relying on updatedAt watermarks", async () => {
    const f = await fixture(), now = new Date("2026-10-23T10:30:00Z");
    await update(f, tx => tx.property.update({ where: { id: f.property.id }, data: { timezone: "Pacific/Kiritimati" } }));
    const western = await update(f, tx => tx.property.create({ data: propertyData(f.org, { timezone: "America/Denver" }) }));
    const createdAt = new Date("2026-01-01"), east = await task(f, { dueDate: new Date("2026-10-24"), createdAt });
    const west = await task(f, { propertyId: western.id, dueDate: new Date("2026-10-24"), createdAt });
    const overdue = await task(f, { propertyId: western.id, dueDate: new Date("2026-10-22"), createdAt, state: "BLOCKED" });
    const first = await pull(f, {}, now);
    expect(first.tasks.map(row => row.id).sort()).toEqual([east.id, overdue.id].sort());
    expect(first.tasks.find(row => row.id === east.id)?.businessDate).toBe("2026-10-24");
    expect((await pull(f, { mode: "assigned" }, now)).tasks.map(row => row.id)).toContain(west.id);
    const next = await pull(f, { cursor: first.cursor }, new Date("2026-10-24T07:30:00Z"));
    expect(next.tasks.map(row => row.id)).toContain(west.id);
  });

  it("enforces ownership, current scoped grants and cursor replay boundaries", async () => {
    const f = await fixture(); await task(f);
    await expect(pull(f, { actor_user_id: f.otherAccount.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(pull(f, { organization_id: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
    const first = await pull(f);
    await expect(pull(f, { cursor: first.cursor, property_id: f.property.id })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(pull(f, { only_known: true })).rejects.toMatchObject({ code: "invalid_cursor" });
    f.ctx.authContext.permissions = new Set(["task:view"]);
    await expect(pull(f, { cursor: first.cursor })).rejects.toMatchObject({ code: "reset_required" });
    expect((await pull(f)).tasks[0].canEdit).toBe(false);
    f.ctx.authContext.permissions = new Set();
    await expect(pull(f)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("matches authorize for each supported scope and assignment condition before pagination", async () => {
    const f = await fixture(), job = await task(f), now = anchor();
    const scopes: Scope[] = [
      { organizationId: f.org }, { organizationId: f.org, scopeType: "property", scopeId: f.property.id },
      { organizationId: f.org, scopeType: "city", scopeId: "Marrakech" }, { organizationId: f.org, scopeType: "region", scopeId: "Marrakech-Safi" },
      { organizationId: f.org, scopeType: "city", scopeId: f.property.cityId ?? "Marrakech" },
      { organizationId: f.org, scopeType: "region", scopeId: f.property.regionId ?? "Marrakech-Safi" },
      ...(["property", "reservation", "job", "owner", "service", "financial_record", "wallet", "field_team"] as const).map(scopeType => ({ organizationId: f.org, scopeType, scopeId: job.id })),
      { organizationId: f.org, resourceType: "task", resourceId: job.id }, { organizationId: f.org, scopeType: "property", scopeId: randomUUID() },
      { organizationId: randomUUID() }
    ];
    const grants: AuthAssignment[] = scopes.map(scope => ({ scope, permissions: new Set(["task:view"]) }));
    grants.push(...[
      { statuses: [] }, { statuses: ["ASSIGNED"] }, { statuses: ["BLOCKED"] }, { assignedToMe: true }, { maxAmount: "100" },
      { timeWindow: { startsAt: new Date(now.getTime() + 5000) } }, { timeWindow: { endsAt: new Date(now.getTime() - 5000) } }
    ].map(conditions => ({ scope: scopes[0], conditions, permissions: new Set(["task:view"]) })));
    for (const assignment of grants) {
      f.ctx.authContext.assignments = [assignment];
      const expected = authorize(f.ctx.authContext, "view", { type: "task", organizationId: f.org, id: job.id, taskId: job.id, jobId: job.id,
        propertyId: f.property.id, city: f.property.cityId ?? f.property.city, region: f.property.regionId ?? f.property.region, status: "ASSIGNED", assignedUserAccountId: f.account.id,
        assignedPersonId: f.person.id, occurredAt: now }, now);
      expect((await pull(f, {}, now)).tasks.map(row => row.id), JSON.stringify(assignment.scope)).toEqual(expected ? [job.id] : []);
    }
  });

  it("keeps concurrent duplicate pulls read-only and checks remaining known records against a checkpoint", async () => {
    const f = await fixture(), job = await task(f), first = await pull(f), now = anchor();
    const repeated = await Promise.all(Array.from({ length: 6 }, () => pull(f, { cursor: first.cursor, only_known: true, known_tasks: known(first.tasks) }, now)));
    for (const result of repeated) expect({ tasks: result.tasks, changes: result.known_changes, tombstones: result.tombstones }).toEqual({ tasks: [], changes: [], tombstones: [] });
    await update(f, tx => tx.operationTask.update({ where: { id: job.id }, data: { assignedToUserAccountId: f.otherAccount.id, assignedToPersonId: f.other.id } }));
    expect((await pull(f, { cursor: first.cursor, only_known: true, known_tasks: known(first.tasks) }, now)).tombstones).toEqual([job.id]);
    expect(await update(f, tx => tx.auditLog.count())).toBe(0); expect(await update(f, tx => tx.syncOp.count())).toBe(0);
  });

  it("supervised pull retains reviewed versions and person-only performers while excluding own and closed work", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate", "task:edit"]);
    const person = await update(f, tx => tx.person.create({ data: { organizationId: f.org, displayName: "Person-only performer" } }));
    const colleague = await task(f, { assignedToPersonId: person.id, assignedToUserAccountId: null });
    const own = await task(f), blocked = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id, state: "BLOCKED" });
    const completed = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id, state: "COMPLETED" });
    const result = fieldPullResultSchema.parse(await pull(f, { mode: "supervised" }));
    expect(result.tasks.map(row => row.id)).toEqual([colleague.id]);
    expect(result.tasks[0]).toMatchObject({ canEdit: false, proxyValidation: { performedByPersonId: person.id, expectedVersion: colleague.version } });
    expect(result.tasks[0]).not.toHaveProperty("proxyValidation.performerName");
    for (const id of [own.id, blocked.id, completed.id]) expect(result.tasks.map(row => row.id)).not.toContain(id);
    expect((await pull(f, { mode: "assigned" })).tasks.map(row => row.id)).toEqual([own.id]);
  });

  it("supervised pull intersects view and validate grants before pagination across denied properties", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    const denied = await update(f, tx => tx.property.create({ data: propertyData(f.org, { name: "Denied supervisor villa" }) }));
    await update(f, tx => tx.operationTask.createMany({ data: Array.from({ length: 60 }, () => ({ organizationId: f.org, propertyId: denied.id,
      assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id, type: "INSPECTION", state: "ASSIGNED", dueDate: new Date("2025-01-01"), titleTranslations: { en: "Denied" }, idempotencyKey: randomUUID() })) }));
    const allowed = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    f.ctx.authContext.assignments = [
      { permissions: new Set(["task:view"]), scope: { organizationId: f.org } },
      { permissions: new Set(["task:validate"]), scope: { organizationId: f.org, scopeType: "property", scopeId: f.property.id } }
    ];
    const result = await pull(f, { mode: "supervised" }); expect(result.tasks.map(row => row.id)).toEqual([allowed.id]); expect(result.next_cursor).toBeNull();
    f.ctx.authContext.assignments = [
      { permissions: new Set(["task:view"]), scope: { organizationId: f.org, scopeType: "property", scopeId: denied.id } },
      { permissions: new Set(["task:validate"]), scope: { organizationId: f.org, scopeType: "property", scopeId: f.property.id } }
    ];
    expect((await pull(f, { mode: "supervised" })).tasks).toEqual([]);
    for (const grant of ["task:view", "task:validate"]) {
      f.ctx.authContext.permissions = new Set([grant]);
      await expect(pull(f, { mode: "supervised" })).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("supervised pull removes reassigned, archived, closed and foreign known records without business writes", async () => {
    const f = await fixture(), foreign = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    const reassigned = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    const archived = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    const closed = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    const active = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id }), alien = await task(foreign);
    const first = await pull(f, { mode: "supervised" }); expect(first.tasks).toHaveLength(4);
    await update(f, async tx => {
      await tx.operationTask.update({ where: { id: reassigned.id }, data: { assignedToPersonId: f.person.id, assignedToUserAccountId: f.account.id } });
      await tx.operationTask.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
      await tx.operationTask.update({ where: { id: closed.id }, data: { state: "CANCELLED" } });
    });
    const result = await pull(f, { mode: "supervised", cursor: first.cursor, only_known: true, known_tasks: [...known(first.tasks), { id: alien.id, revision: null }] });
    expect(result.tombstones.sort()).toEqual([reassigned.id, archived.id, closed.id, alien.id].sort()); expect(result.tombstones).not.toContain(active.id);
    expect(await update(f, tx => tx.auditLog.count())).toBe(0); expect(await update(f, tx => tx.syncOp.count())).toBe(0);
    expect(await update(f, tx => tx.operationTask.count({ where: { organizationId: foreign.org } }))).toBe(0);
  });

  it("supervised pull detects critical progress and performer metadata changes without granting personal visibility", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    const job = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    const first = await pull(f, { mode: "supervised" });
    expect(first.tasks[0]).not.toHaveProperty("proxyValidation.performerName");
    await update(f, tx => tx.operationTask.update({ where: { id: job.id }, data: { version: { increment: 1 } } }));
    const changed = await pull(f, { mode: "supervised", known_tasks: known(first.tasks) });
    expect(changed.known_changes[0]).toHaveProperty("proxyValidation.expectedVersion", job.version + 1);
    f.ctx.authContext.permissions = new Set(["task:view", "task:validate", "team_member:view"]);
    f.ctx.authContext.assignments = [
      { permissions: new Set(["task:view", "task:validate"]), scope: { organizationId: f.org } },
      { permissions: new Set(["team_member:view"]), scope: { organizationId: f.org, scopeType: "property", scopeId: randomUUID() } }
    ];
    expect((await pull(f, { mode: "supervised" })).tasks[0]).not.toHaveProperty("proxyValidation.performerName");
    f.ctx.authContext.assignments = [
      { permissions: new Set(["task:view", "task:validate"]), scope: { organizationId: f.org } },
      { permissions: new Set(["team_member:view"]), scope: { organizationId: f.org } }
    ];
    const visible = await pull(f, { mode: "supervised" }); expect(visible.tasks[0]).toHaveProperty("proxyValidation.performerName", f.other.displayName);
    await update(f, tx => tx.person.update({ where: { id: f.other.id }, data: { displayName: "Corrected performer" } }));
    const renamed = await pull(f, { mode: "supervised", known_tasks: known(visible.tasks) });
    expect(renamed.known_changes[0]).toHaveProperty("proxyValidation.performerName", "Corrected performer");
    expect(renamed.known_changes[0].revision).not.toBe(visible.tasks[0].revision);
    await expect(update(f, tx => tx.person.update({ where: { id: f.other.id }, data: { archivedAt: new Date() } }))).rejects.toThrow(/clear tasks and wallet/u);
    await update(f, tx => tx.operationTask.update({ where: { id: job.id }, data: { assignedToPersonId: null, assignedToUserAccountId: null, state: "PLANNED" } }));
    await update(f, tx => tx.person.update({ where: { id: f.other.id }, data: { archivedAt: new Date() } }));
    expect((await pull(f, { mode: "supervised", known_tasks: known(renamed.known_changes) })).tombstones).toEqual([job.id]);
  });

  it("supervised pull binds cursor audience and resets expired or changed validation scope", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    await task(f); const colleague = await task(f, { assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id });
    const first = await pull(f, { mode: "supervised" }), assigned = await pull(f, { mode: "assigned" });
    await expect(pull(f, { mode: "assigned", cursor: first.cursor })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(pull(f, { mode: "supervised", cursor: assigned.cursor })).rejects.toMatchObject({ code: "invalid_cursor" });
    f.ctx.authContext.assignments = [{ permissions: new Set(["task:view", "task:validate"]), scope: { organizationId: f.org, scopeType: "job", scopeId: randomUUID() } }];
    await expect(pull(f, { mode: "supervised", cursor: first.cursor })).rejects.toMatchObject({ code: "reset_required" });
    expect((await pull(f, { mode: "supervised", known_tasks: known(first.tasks) })).tombstones).toEqual([colleague.id]);
    f.ctx.authContext.assignments = [{ permissions: new Set(["task:view"]), scope: { organizationId: f.org } },
      { permissions: new Set(["task:validate"]), scope: { organizationId: f.org }, validTo: new Date("2001-01-01") }];
    await expect(pull(f, { mode: "supervised" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("supervised pull paginates current colleague work and rejects actor and tenant substitution", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    await update(f, tx => tx.operationTask.createMany({ data: Array.from({ length: 53 }, () => ({ organizationId: f.org, propertyId: f.property.id,
      assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id, type: "INSPECTION", state: "ASSIGNED", dueDate: new Date(day), titleTranslations: { en: "Colleague" }, idempotencyKey: randomUUID() })) }));
    const first = await pull(f, { mode: "supervised" }); expect(first.tasks).toHaveLength(50); expect(first.next_cursor).toBeTruthy();
    const second = await pull(f, { mode: "supervised", cursor: first.next_cursor }); expect(second.tasks).toHaveLength(3); expect(second.next_cursor).toBeNull();
    expect(new Set([...first.tasks, ...second.tasks].map(row => row.id)).size).toBe(53);
    await expect(pull(f, { mode: "supervised", actor_user_id: f.otherAccount.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(pull(f, { mode: "supervised", organization_id: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
    const repeated = await Promise.all(Array.from({ length: 6 }, () => pull(f, { mode: "supervised", cursor: second.cursor, only_known: true, known_tasks: known(second.tasks) })));
    for (const row of repeated) expect({ tasks: row.tasks, changes: row.known_changes, tombstones: row.tombstones }).toEqual({ tasks: [], changes: [], tombstones: [] });
  });

  it("supervised pull uses property timezones for future and overdue work without broadening assigned mode", async () => {
    const f = await fixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:validate"]);
    await update(f, tx => tx.property.update({ where: { id: f.property.id }, data: { timezone: "Pacific/Kiritimati" } }));
    const future = await task(f, { dueDate: new Date("2026-10-25"), assignedToPersonId: f.other.id, assignedToUserAccountId: f.otherAccount.id, createdAt: new Date("2026-01-01") });
    const own = await task(f, { dueDate: new Date("2026-10-24"), createdAt: new Date("2026-01-01") });
    const now = new Date("2026-10-23T10:30:00Z"), result = await pull(f, { mode: "supervised" }, now);
    expect(result.tasks).toHaveLength(1); expect(result.tasks[0]).toMatchObject({ id: future.id, businessDate: "2026-10-24", dueDate: "2026-10-25" });
    expect((await pull(f, { mode: "today" }, now)).tasks.map(row => row.id)).toEqual([own.id]);
  });
});
