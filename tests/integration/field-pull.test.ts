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
});
