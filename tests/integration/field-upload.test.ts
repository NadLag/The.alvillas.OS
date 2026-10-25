import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FakeStorageProvider } from "@/platform/providers/fakes";
import defaultPolicy from "@/platform/config/defaults/operations.json";
import { startFieldUpload, signFieldUploadPart, storeFieldUploadPart, completeFieldUpload, FieldUploadUnavailableError } from "@/modules/reservations/application/field-upload-service";
import { fieldUploadChunkBytes } from "@/modules/reservations/domain/field-upload";
import { pushSyncOps } from "@/modules/reservations/application/sync-service";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { FieldUploadRepository } from "@/modules/reservations/infrastructure/field-upload-repository";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { cleanupFieldUploadParts } from "@/modules/reservations/application/field-upload-cleanup";
import { expireInactiveFieldUploads } from "@/modules/reservations/application/field-upload-lifecycle";
import { fieldUploadLifecycleKey } from "@/platform/config/field-upload-lifecycle-policy";
import { temporaryPartLeaseMilliseconds, type TemporaryUploadPart } from "@/platform/storage/upload-protocol";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const deps = () => ({ db, requestId: randomUUID() });
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Resumable upload integration", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Photo worker" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Photo villa", addressLine1: "Test", city: "Marrakech",
      propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const task = await tx.operationTask.create({ data: { organizationId: org, propertyId: property.id, assignedToUserAccountId: account.id,
      assignedToPersonId: person.id, state: "ASSIGNED", type: "INSPECTION", dueDate: new Date("2027-01-10"),
      titleTranslations: { en: "Inspect photo", fr: "Vérifier la photo" }, idempotencyKey: randomUUID(), createdBy: account.id } });
    const ctx: ReservationActorContext = { organizationId: org, actorId: account.id, personId: person.id, authContext: { organizationId: org,
      userAccountId: account.id, personId: person.id, permissions: new Set(["task:view", "task:edit"]), scopes: [{ organizationId: org }] } };
    const input = { organization_id: org, actor_user_id: account.id, device_id: randomUUID(), manifest: { protocolVersion: 1, localId: randomUUID(),
      taskId: task.id, contentType: "image/png", note: "Photo provenance", size: 11, sha256: "a".repeat(64), parts: [{ sha256: "b".repeat(64), size: 11 }] } };
    return { org, person, account, property, task, ctx, input };
  });
}

async function photoFixture() {
  const f = await fixture(), bytes = Buffer.alloc(fieldUploadChunkBytes + 97, 0x5a);
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64").copy(bytes);
  const chunks = [bytes.subarray(0, fieldUploadChunkBytes), bytes.subarray(fieldUploadChunkBytes)];
  const manifest = { ...f.input.manifest, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    parts: chunks.map(chunk => ({ size: chunk.length, sha256: createHash("sha256").update(chunk).digest("hex") })) };
  const upload = await startFieldUpload(f.ctx, { ...f.input, manifest }, deps());
  const request = { organization_id: f.org, actor_user_id: f.account.id, device_id: f.input.device_id, uploadId: upload.uploadId };
  const storage = { createSignedUploadUrl: ({ key }: { key: string }) => Promise.resolve({ url: `https://objects.example.test/${key}` }),
    createSignedDownloadUrl: ({ key }: { key: string }) => Promise.resolve({ url: `https://objects.example.test/${key}` }) };
  return { ...f, bytes, chunks, upload, request, storage, manifest };
}

function photoTransport(handler: (url: URL, options?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((input, options) => Promise.resolve().then(() => handler(
    new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), options)));
}

function idlePolicy(f: Awaited<ReturnType<typeof fixture>>, minutes: number | null, scopeType: "organization" | "property" = "property", effectiveFrom = new Date("2020-01-01")) {
  return withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: fieldUploadLifecycleKey,
    scopeType, scopeId: scopeType === "property" ? f.property.id : null, effectiveFrom,
    reason: "Explicit field transport expiry integration policy", value: { openUploadIdleAfterMinutes: minutes } }));
}

describe("field photo uploads on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url) return;
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Upload fixture database must be isolated locally");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
    expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it.skipIf(!url)("expires idle OPEN transport once under its effective scoped policy while an explicit property disable preserves work", async () => {
    const f = await fixture(), started = await startFieldUpload(f.ctx, f.input, deps()), now = new Date(Date.now() + 3_600_000);
    expect(await expireInactiveFieldUploads(f.org, { db, now })).toEqual({ expired: 0 });
    await idlePolicy(f, 0, "organization"); await idlePolicy(f, null);
    expect(await expireInactiveFieldUploads(f.org, { db, now })).toEqual({ expired: 0 });
    const rule = await idlePolicy(f, 1, "property", new Date(now.getTime() - 1));
    const results = await Promise.all([expireInactiveFieldUploads(f.org, { db, now }), expireInactiveFieldUploads(f.org, { db, now })]);
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: started.uploadId } })).toMatchObject({ status: "CANCELLED", generation: 1,
        expiryPolicy: { openUploadIdleAfterMinutes: 1, configRuleId: rule.id, configVersion: rule.version }, expiredAt: now, evidenceId: null });
      const audit = await tx.auditLog.findMany({ where: { resourceId: f.task.id, action: "task.photo.upload.expired" } });
      expect(audit).toHaveLength(1); expect(audit[0].actorId).toBeNull();
      expect(await tx.operationTaskEvidence.count()).toBe(0); expect(await tx.outboxEvent.count()).toBe(0);
    });
  });
  it.skipIf(!url)("protects a live signed PUT lease even when the configured idle threshold has elapsed", async () => {
    const f = await fixture(), now = new Date(Date.now() + 60_000), upload = await startFieldUpload(f.ctx, f.input, { ...deps(), now });
    await idlePolicy(f, 1); const storage = new FakeStorageProvider("test");
    await signFieldUploadPart(f.ctx, { organization_id: f.org, actor_user_id: f.account.id, device_id: f.input.device_id, uploadId: upload.uploadId, index: 0 }, { ...deps(), storage, now });
    const remove = vi.fn().mockResolvedValue(undefined), cleanup = { db, storage: { deleteTemporaryUploadPart: remove } };
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date(now.getTime() + temporaryPartLeaseMilliseconds - 1) })).toEqual({ cleaned: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date(now.getTime() + temporaryPartLeaseMilliseconds) })).toEqual({ cleaned: 1 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.photo.upload.expired" } }))).toBe(1);
  });
  it.skipIf(!url)("recovers the same manifest and upload identity in a fenced generation and attaches it exactly once", async () => {
    const f = await photoFixture(), now = new Date(Date.now() + 3_600_000), remove = vi.fn().mockResolvedValue(undefined);
    await idlePolicy(f, 1);
    expect(await expireInactiveFieldUploads(f.org, { db, now })).toEqual({ expired: 1 });
    const input = { ...f.input, manifest: f.manifest, include_generation: true };
    await expect(startFieldUpload(f.ctx, input, { ...deps(), now })).rejects.toBeInstanceOf(FieldUploadUnavailableError);
    await expect(startFieldUpload(f.ctx, { ...input, include_generation: false }, { ...deps(), now })).rejects.toBeInstanceOf(ReservationConflictError);
    expect(await cleanupFieldUploadParts(f.org, { db, now, storage: { deleteTemporaryUploadPart: remove } })).toEqual({ cleaned: 1 });
    const recovered = await Promise.all([startFieldUpload(f.ctx, input, { ...deps(), now }), startFieldUpload(f.ctx, input, { ...deps(), now })]);
    expect(recovered).toEqual([{ uploadId: f.upload.uploadId, status: "OPEN", generation: 2 }, { uploadId: f.upload.uploadId, status: "OPEN", generation: 2 }]);
    const request = { ...f.request, generation: 2 }, objects = new Map<string, Uint8Array>();
    const transport = photoTransport((url, options) => {
      const key = url.pathname.slice(1);
      if (options?.method === "PUT") { objects.set(key, new Uint8Array(options.body as Uint8Array)); return new Response(null, { status: 200 }); }
      const bytes = objects.get(key); return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
    });
    await expect(signFieldUploadPart(f.ctx, { ...f.request, index: 0 }, { ...deps(), storage: f.storage, now })).rejects.toEqual(new ReservationConflictError("upload_generation_changed"));
    await expect(completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport, now })).rejects.toBeInstanceOf(ReservationConflictError);
    expect((await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).cleaned(f.upload.uploadId, now, 1))).count).toBe(0);
    for (let index = 0; index < f.chunks.length; index++) await storeFieldUploadPart(f.ctx, { ...request, index }, f.chunks[index], { ...deps(), storage: f.storage, transport, now });
    expect([...objects.keys()]).toEqual(f.chunks.map((_, index) => `${f.org}/uploads/${f.upload.uploadId}/generation-2/part-${index}`));
    expect(await completeFieldUpload(f.ctx, request, { ...deps(), storage: f.storage, transport, now })).toEqual({ uploadId: f.upload.uploadId, status: "READY", generation: 2 });
    const batch = syncPushInputSchema.parse({ ...f.request, op_schema_version: 1, ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: f.task.id, uploadId: f.upload.uploadId } }] });
    const synced = await Promise.all([pushSyncOps(f.ctx, batch, deps()), pushSyncOps(f.ctx, batch, deps())]);
    expect(synced.map(result => result.results[0].status).sort()).toEqual(["APPLIED", "DUPLICATE"]);
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } })).toMatchObject({ generation: 2, status: "ATTACHED", manifest: f.manifest, deviceId: f.input.device_id, localId: f.manifest.localId, expiredAt: null, expiryPolicy: null });
      for (const action of ["task.photo.upload.started", "task.photo.upload.expired", "task.photo.upload.recovered", "task.photo.upload.ready", "task.evidence.attached"])
        expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action } })).toBe(1);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.task.id } })).toBe(1); expect(await tx.syncOp.count({ where: { status: "APPLIED" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted" } })).toBe(0);
    });
  });
  it.skipIf(!url)("denies cross-tenant, revoked, reassigned, changed-device and changed-manifest recovery", async () => {
    const f = await fixture(), foreign = await fixture(), now = new Date(Date.now() + 3_600_000);
    await startFieldUpload(f.ctx, f.input, deps()); await idlePolicy(f, 1);
    await cleanupFieldUploadParts(f.org, { db, now, storage: { deleteTemporaryUploadPart: vi.fn().mockResolvedValue(undefined) } });
    const input = { ...f.input, include_generation: true };
    await expect(startFieldUpload(foreign.ctx, { ...input, organization_id: foreign.org, actor_user_id: foreign.account.id }, { ...deps(), now })).rejects.toBeInstanceOf(ReservationNotFoundError);
    const revoked = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["task:view"]) } };
    await expect(startFieldUpload(revoked, input, { ...deps(), now })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(startFieldUpload(f.ctx, { ...input, device_id: randomUUID() }, { ...deps(), now })).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(startFieldUpload(f.ctx, { ...input, manifest: { ...input.manifest, note: "Changed original evidence" } }, { ...deps(), now })).rejects.toBeInstanceOf(ReservationConflictError);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: null, assignedToPersonId: null, state: "PLANNED" } }));
    await expect(startFieldUpload(f.ctx, input, { ...deps(), now })).rejects.toBeInstanceOf(ReservationNotFoundError);
    expect(await withTenant(db, foreign.org, tx => tx.operationEvidenceUpload.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "task.photo.upload.recovered" } }))).toBe(0);
  });
  it.skipIf(!url)("keeps a late cleanup acknowledgement and old DELETEs fenced away from a recovered transfer", async () => {
    const f = await photoFixture(), now = new Date(Date.now() + 3_600_000), objects = new Map<string, Uint8Array>();
    await idlePolicy(f, 0);
    for (let index = 0; index < f.chunks.length; index++) objects.set(`${f.org}/uploads/${f.upload.uploadId}/part-${index}`, new Uint8Array(f.chunks[index]));
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { started = resolve; });
    const remove = (part: TemporaryUploadPart) => { objects.delete(`${part.organizationId}/uploads/${part.uploadId}/part-${part.index}`); return Promise.resolve(); };
    const late = cleanupFieldUploadParts(f.org, { db, now, storage: { deleteTemporaryUploadPart: async part => {
      if (part.index === 0) { started(); await held; } await remove(part);
    } } });
    try {
      await observed;
      expect(await cleanupFieldUploadParts(f.org, { db, now, storage: { deleteTemporaryUploadPart: remove } })).toEqual({ cleaned: 1 });
      expect(await startFieldUpload(f.ctx, { ...f.input, manifest: f.manifest, include_generation: true }, { ...deps(), now })).toMatchObject({ generation: 2 });
      const transport = photoTransport((url, options) => { objects.set(url.pathname.slice(1), new Uint8Array(options?.body as Uint8Array)); return new Response(null, { status: 200 }); });
      await storeFieldUploadPart(f.ctx, { ...f.request, index: 0, generation: 2 }, f.chunks[0], { ...deps(), storage: f.storage, transport, now });
      release(); expect(await late).toEqual({ cleaned: 0 });
      expect([...objects.keys()]).toEqual([`${f.org}/uploads/${f.upload.uploadId}/generation-2/part-0`]);
      expect(await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }))).toMatchObject({ generation: 2, status: "OPEN", cleanedAt: null });
    } finally { release(); await late; }
  });
  it.skipIf(!url)("uses server activity, future effective policy versions and tenant isolation for idle decisions", async () => {
    const f = await fixture(), foreign = await fixture(), base = new Date(Date.now() + 60_000);
    const upload = await startFieldUpload(f.ctx, f.input, { ...deps(), now: base }); await startFieldUpload(foreign.ctx, foreign.input, { ...deps(), now: base });
    await idlePolicy(foreign, 0);
    expect(await expireInactiveFieldUploads(f.org, { db, now: new Date(base.getTime() + 120_000) })).toEqual({ expired: 0 });
    await idlePolicy(f, 1, "property", new Date(base.getTime() + 120_000));
    expect(await expireInactiveFieldUploads(f.org, { db, now: new Date(base.getTime() + 119_999) })).toEqual({ expired: 0 });
    const touch = new Date(base.getTime() + 119_998);
    await startFieldUpload(f.ctx, { ...f.input, include_generation: true }, { ...deps(), now: touch });
    expect(await expireInactiveFieldUploads(f.org, { db, now: new Date(touch.getTime() + 59_999) })).toEqual({ expired: 0 });
    expect(await expireInactiveFieldUploads(f.org, { db, now: new Date(touch.getTime() + 60_000) })).toEqual({ expired: 1 });
    expect(await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: upload.uploadId } }))).toMatchObject({ lastActivityAt: touch });
    expect(await withTenant(db, foreign.org, tx => tx.operationEvidenceUpload.findFirstOrThrow())).toMatchObject({ status: "OPEN", expiredAt: null });
    expect(await withTenant(db, f.org, tx => tx.operationEvidenceUpload.count({ where: { organizationId: foreign.org } }))).toBe(0);
  });
  it.skipIf(!url)("rejects generation changes without an expired, physically cleaned OPEN lineage", async () => {
    const f = await fixture(), upload = await startFieldUpload(f.ctx, f.input, deps());
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: upload.uploadId }, data: { generation: 2 } }))).rejects.toThrow(/generation/u);
    await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).cancel(upload.uploadId));
    expect((await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).recover(upload.uploadId, 1, new Date()))).count).toBe(0);
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: upload.uploadId }, data: { status: "OPEN", generation: 2 } }))).rejects.toThrow(/generation/u);
    await expect(startFieldUpload(f.ctx, { ...f.input, include_generation: true }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
  });
  it.skipIf(!url)("serializes duplicate starts and rejects actor, device and payload reuse", async () => {
    const f = await fixture(), results = await Promise.all([startFieldUpload(f.ctx, f.input, deps()), startFieldUpload(f.ctx, f.input, deps())]);
    expect(results[0]).toEqual(results[1]);
    expect(await withTenant(db, f.org, tx => tx.operationEvidenceUpload.count())).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.photo.upload.started" } }))).toBe(1);
    await expect(startFieldUpload(f.ctx, { ...f.input, actor_user_id: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(startFieldUpload(f.ctx, { ...f.input, device_id: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(startFieldUpload(f.ctx, { ...f.input, manifest: { ...f.input.manifest, note: "Changed upload evidence" } }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
    const stored = await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findFirstOrThrow());
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: stored.id }, data: { manifestHash: "c".repeat(64) } }))).rejects.toThrow(/immutable/u);
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.delete({ where: { id: stored.id } }))).rejects.toThrow();
  });
  it.skipIf(!url)("rechecks tenant, assignment, effective grants and current configured photo limits before signing", async () => {
    const f = await fixture(), other = await fixture(), upload = await startFieldUpload(f.ctx, f.input, deps()), storage = new FakeStorageProvider("test");
    const signed = vi.spyOn(storage, "createSignedUploadUrl"), part = { organization_id: f.org, actor_user_id: f.account.id, device_id: f.input.device_id, uploadId: upload.uploadId, index: 0 };
    await signFieldUploadPart(f.ctx, part, { ...deps(), storage }); expect(signed).toHaveBeenCalledTimes(1);
    expect(signed.mock.calls[0][0].key).toBe(`${f.org}/uploads/${upload.uploadId}/part-0`); signed.mockClear();
    await expect(signFieldUploadPart(other.ctx, { ...part, organization_id: other.org, actor_user_id: other.account.id }, { ...deps(), storage })).rejects.toBeInstanceOf(ReservationNotFoundError);
    expect(await withTenant(db, other.org, tx => tx.operationEvidenceUpload.count({ where: { id: upload.uploadId } }))).toBe(0);
    await expect(signFieldUploadPart(f.ctx, { ...part, device_id: randomUUID() }, { ...deps(), storage })).rejects.toBeInstanceOf(ReservationNotFoundError);
    const expired = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [{ permissions: f.ctx.authContext.permissions,
      scope: { organizationId: f.org }, validTo: new Date("2001-01-01") }] } };
    await expect(signFieldUploadPart(expired, part, { ...deps(), storage })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "ops.task_policy", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date(Date.now() - 1000), reason: "Configured photo limit changes during upload", value: { ...defaultPolicy, evidence_max_bytes: 10 } }));
    await expect(signFieldUploadPart(f.ctx, part, { ...deps(), storage })).rejects.toBeInstanceOf(ReservationConflictError);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: null, assignedToPersonId: null, state: "PLANNED" } }));
    await expect(signFieldUploadPart(f.ctx, part, { ...deps(), storage })).rejects.toBeInstanceOf(ReservationNotFoundError);
    expect(signed).not.toHaveBeenCalled();
  });
  it.skipIf(!url)("guards upload transitions and binds permanent evidence to its original tenant, actor and digest", async () => {
    const f = await fixture(), other = await fixture(), upload = await startFieldUpload(f.ctx, f.input, deps());
    await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).ready(upload.uploadId, new Date()));
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: upload.uploadId }, data: { status: "OPEN" } }))).rejects.toThrow();
    const foreign = await withTenant(db, other.org, tx => tx.operationTaskEvidence.create({ data: { organizationId: other.org, taskId: other.task.id,
      createdBy: other.account.id, note: "Foreign evidence" } }));
    await expect(withTenant(admin, f.org, tx => new FieldUploadRepository(tx, f.org).attach(upload.uploadId, foreign.id, new Date()))).rejects.toThrow(/mismatch/u);
    const evidence = await withTenant(db, f.org, tx => tx.operationTaskEvidence.create({ data: { organizationId: f.org, taskId: f.task.id, createdBy: f.account.id,
      note: f.input.manifest.note, contentType: f.input.manifest.contentType, size: f.input.manifest.size, sha256: f.input.manifest.sha256,
      storageKey: `${f.org}/tasks/${f.task.id}/uploads/${upload.uploadId}` } }));
    expect((await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).attach(upload.uploadId, evidence.id, new Date()))).count).toBe(1);
    expect((await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).attach(upload.uploadId, evidence.id, new Date()))).count).toBe(0);
  });
  it.skipIf(!url)("assembles bounded verified parts outside locks and acknowledges concurrent completion once", async () => {
    const f = await photoFixture(), permanent: Uint8Array[] = [];
    const transport = photoTransport((url, options) => {
      if (options?.method === "PUT") {
        expect(url.pathname).toBe(`/${f.org}/tasks/${f.task.id}/uploads/${f.upload.uploadId}`);
        expect(options.headers).toEqual({ "Content-Type": "image/png" });
        permanent.push(new Uint8Array(options.body as Uint8Array)); return new Response(null, { status: 200 });
      }
      const index = Number(url.pathname.split("part-").at(-1));
      return new Response(new Uint8Array(f.chunks[index]), { status: 200 });
    });
    const results = await Promise.all([completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport }),
      completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })]);
    expect(results).toEqual([{ uploadId: f.upload.uploadId, status: "READY" }, { uploadId: f.upload.uploadId, status: "READY" }]);
    expect(permanent).toHaveLength(2); for (const bytes of permanent) expect(Buffer.from(bytes)).toEqual(f.bytes);
    transport.mockClear(); await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport }); expect(transport).not.toHaveBeenCalled();
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.photo.upload.ready" } })).toBe(1);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.task.id } })).toBe(0);
      expect(await tx.outboxEvent.count()).toBe(0);
    });
  });
  it.skipIf(!url)("retains the original upload after missing objects, interrupted writes or digest failures for a safe retry", async () => {
    const f = await photoFixture();
    const missing = photoTransport(() => new Response(null, { status: 404 }));
    await expect(completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport: missing })).rejects.toBeInstanceOf(FieldUploadUnavailableError);
    const damaged = photoTransport(url => {
      const index = Number(url.pathname.split("part-").at(-1));
      return new Response(new Uint8Array(f.chunks[index].length), { status: 200 });
    });
    await expect(completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport: damaged })).rejects.toBeInstanceOf(ReservationConflictError);
    let failPut = true;
    const transport = photoTransport((url, options) => {
      if (options?.method === "PUT") { if (failPut) throw Error("Private transport diagnostic must not escape"); return new Response(null, { status: 200 }); }
      const index = Number(url.pathname.split("part-").at(-1));
      return new Response(new Uint8Array(f.chunks[index]), { status: 200 });
    });
    await expect(completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })).rejects.toEqual(new FieldUploadUnavailableError());
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } })).status).toBe("OPEN");
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.photo.upload.ready" } })).toBe(0);
    });
    failPut = false;
    expect(await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })).toEqual({ uploadId: f.upload.uploadId, status: "READY" });
  });
  it.skipIf(!url)("rechecks reassignment after object I/O before making an upload ready", async () => {
    const f = await photoFixture();
    const transport = photoTransport(async (url, options) => {
      if (options?.method === "PUT") {
        // This would deadlock if R2 work retained the task transaction's locks.
        await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: null, assignedToPersonId: null, state: "PLANNED" } }));
        return new Response(null, { status: 200 });
      }
      const index = Number(url.pathname.split("part-").at(-1));
      return new Response(new Uint8Array(f.chunks[index]), { status: 200 });
    });
    await expect(completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })).rejects.toBeInstanceOf(ReservationNotFoundError);
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } })).status).toBe("OPEN");
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.photo.upload.ready" } })).toBe(0);
    });
  });
  it.skipIf(!url)("proxies only verified bounded chunks and safely repeats a PUT whose acknowledgement was lost", async () => {
    const f = await photoFixture(), signed = vi.spyOn(f.storage, "createSignedUploadUrl"), objects = new Map<string, Uint8Array>();
    let loseAcknowledgement = true;
    const transport = photoTransport((url, options) => {
      const key = url.pathname.slice(1);
      if (options?.method === "PUT") {
        objects.set(key, new Uint8Array(options.body as Uint8Array));
        if (loseAcknowledgement) { loseAcknowledgement = false; throw Error("Lost object acknowledgement"); }
        return new Response(null, { status: 200 });
      }
      const bytes = objects.get(key); return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
    });
    const part = { ...f.request, index: 0 };
    await expect(storeFieldUploadPart(f.ctx, part, new Uint8Array(f.chunks[0].length), { ...deps(), storage: f.storage, transport })).rejects.toBeInstanceOf(ReservationConflictError);
    expect(signed).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    await expect(storeFieldUploadPart(f.ctx, part, f.chunks[0], { ...deps(), storage: f.storage, transport })).rejects.toBeInstanceOf(FieldUploadUnavailableError);
    expect(await storeFieldUploadPart(f.ctx, part, f.chunks[0], { ...deps(), storage: f.storage, transport })).toEqual({ stored: true });
    expect(objects.size).toBe(1); expect(objects.get(`${f.org}/uploads/${f.upload.uploadId}/part-0`)).toEqual(new Uint8Array(f.chunks[0]));
    await storeFieldUploadPart(f.ctx, { ...part, index: 1 }, f.chunks[1], { ...deps(), storage: f.storage, transport });
    expect(await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })).toEqual({ uploadId: f.upload.uploadId, status: "READY" });
    expect(objects.get(`${f.org}/tasks/${f.task.id}/uploads/${f.upload.uploadId}`)).toEqual(new Uint8Array(f.bytes));
    expect(signed).toHaveBeenCalledTimes(4);
  });
  it.skipIf(!url)("keeps prior private evidence immutable when a new assignee reuses a client photo nonce", async () => {
    const f = await photoFixture(), objects = new Map<string, Uint8Array>();
    const parts = new Map<string, readonly Uint8Array[]>([[f.upload.uploadId, f.chunks]]);
    const transport = photoTransport((url, options) => {
      if (options?.method === "PUT") {
        expect(options.body).toBeInstanceOf(Uint8Array);
        objects.set(url.pathname.slice(1), new Uint8Array(options.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const uploadId = url.pathname.split("/uploads/")[1]?.split("/")[0], index = Number(url.pathname.split("part-").at(-1));
      const bytes = uploadId && parts.get(uploadId)?.[index];
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
    });
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    const input = syncPushInputSchema.parse({ ...f.request, op_schema_version: 1, ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach",
      payload: { taskId: f.task.id, uploadId: f.upload.uploadId } }] });
    expect((await pushSyncOps(f.ctx, input, deps())).results[0].status).toBe("APPLIED");
    const original = await withTenant(db, f.org, tx => tx.operationTaskEvidence.findFirstOrThrow({ where: { taskId: f.task.id } }));
    expect(objects.get(original.storageKey!)).toEqual(new Uint8Array(f.bytes));
    const next = await withTenant(db, f.org, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Next photo assignee" } });
      const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } });
      await tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: account.id, assignedToPersonId: person.id } });
      return { person, account };
    });
    const ctx = { ...f.ctx, actorId: next.account.id, personId: next.person.id, authContext: {
      ...f.ctx.authContext, userAccountId: next.account.id, personId: next.person.id
    } };
    const bytes = new Uint8Array(f.bytes); bytes[bytes.length - 1] ^= 1;
    const chunks = [bytes.subarray(0, fieldUploadChunkBytes), bytes.subarray(fieldUploadChunkBytes)];
    const manifest = { ...f.manifest, sha256: createHash("sha256").update(bytes).digest("hex"),
      parts: chunks.map(chunk => ({ size: chunk.length, sha256: createHash("sha256").update(chunk).digest("hex") })) };
    const device = randomUUID(), uploaded = await startFieldUpload(ctx, { ...f.input, actor_user_id: next.account.id, device_id: device, manifest }, deps());
    parts.set(uploaded.uploadId, chunks);
    await completeFieldUpload(ctx, { organization_id: f.org, actor_user_id: next.account.id, device_id: device, uploadId: uploaded.uploadId }, { ...deps(), storage: f.storage, transport });
    expect(objects.get(original.storageKey!)).toEqual(new Uint8Array(f.bytes));
    expect(createHash("sha256").update(objects.get(original.storageKey!)!).digest("hex")).toBe(original.sha256);
    const secondInput = syncPushInputSchema.parse({ organization_id: f.org, actor_user_id: next.account.id, device_id: device, op_schema_version: 1,
      ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: f.task.id, uploadId: uploaded.uploadId } }] });
    expect((await pushSyncOps(ctx, secondInput, deps())).results[0].status).toBe("APPLIED");
    await withTenant(db, f.org, async tx => {
      const evidence = await tx.operationTaskEvidence.findMany({ where: { taskId: f.task.id } });
      expect(evidence).toHaveLength(2); expect(new Set(evidence.map(row => row.storageKey)).size).toBe(2);
      for (const row of evidence) expect(createHash("sha256").update(objects.get(row.storageKey!)!).digest("hex")).toBe(row.sha256);
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.evidence.attached" } })).toBe(2);
    });
  });
  it.skipIf(!url)("uses native evidence persistence and the original sync operation for lost acknowledgements and concurrent retries", async () => {
    const f = await photoFixture();
    const transport = photoTransport((url, options) => options?.method === "PUT" ? new Response(null, { status: 200 }) :
      new Response(new Uint8Array(f.chunks[Number(url.pathname.split("part-").at(-1))]), { status: 200 }));
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    const input = syncPushInputSchema.parse({ ...f.request, op_schema_version: 1, ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach",
      payload: { taskId: f.task.id, uploadId: f.upload.uploadId } }] });
    const results = await Promise.all([pushSyncOps(f.ctx, input, deps()), pushSyncOps(f.ctx, input, deps())]);
    expect(results.map(result => result.results[0].status).sort()).toEqual(["APPLIED", "DUPLICATE"]);
    expect((await pushSyncOps(f.ctx, input, deps())).results[0].status).toBe("DUPLICATE");
    const changed = structuredClone(input);
    if (changed.ops[0].type !== "field_task.evidence.attach") throw Error("Expected photo operation fixture");
    changed.ops[0].payload.uploadId = randomUUID();
    expect((await pushSyncOps(f.ctx, changed, deps())).results[0].error_code).toBe("REJECTED_IDEMPOTENCY_KEY_REUSED");
    expect((await pushSyncOps(f.ctx, { ...input, device_id: randomUUID() }, deps())).results[0].status).toBe("REJECTED");
    const secondKey = structuredClone(input); secondKey.ops[0].client_op_id = randomUUID();
    expect((await pushSyncOps(f.ctx, secondKey, deps())).results[0].status).toBe("DUPLICATE");
    await withTenant(db, f.org, async tx => {
      const evidence = await tx.operationTaskEvidence.findMany({ where: { taskId: f.task.id } });
      expect(evidence).toHaveLength(1); expect(evidence[0]).toMatchObject({ createdBy: f.account.id, sha256: f.manifest.sha256,
        size: f.manifest.size, contentType: "image/png", note: f.manifest.note, storageKey: `${f.org}/tasks/${f.task.id}/uploads/${f.upload.uploadId}` });
      expect((await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }))).toMatchObject({ status: "ATTACHED", evidenceId: evidence[0].id });
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.evidence.attached" } })).toBe(1);
      expect(await tx.syncOp.count({ where: { status: "APPLIED" } })).toBe(1);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.task.id } })).state).toBe("ASSIGNED");
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted" } })).toBe(0);
    });
  });
  it.skipIf(!url)("rechecks current upload ownership and permissions when applying queued evidence", async () => {
    const f = await photoFixture(), other = await fixture();
    const batch = () => syncPushInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, device_id: f.input.device_id, op_schema_version: 1,
      ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: f.task.id, uploadId: f.upload.uploadId } }] });
    expect((await pushSyncOps(f.ctx, batch(), deps())).results[0]).toMatchObject({ status: "CONFLICT", error_code: "TASK_EVIDENCE_CONFLICT" });
    await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).ready(f.upload.uploadId, new Date()));
    const revoked = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["task:view"]) } };
    expect((await pushSyncOps(revoked, batch(), deps())).results[0].error_code).toBe("REJECTED_FORBIDDEN");
    const foreign = { ...batch(), organization_id: other.org, actor_user_id: other.account.id, device_id: randomUUID() };
    expect((await pushSyncOps(other.ctx, foreign, deps())).results[0].status).toBe("REJECTED");
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: null, assignedToPersonId: null, state: "PLANNED" } }));
    expect((await pushSyncOps(f.ctx, batch(), deps())).results[0].error_code).toBe("REJECTED_NOT_ASSIGNED");
    expect(await withTenant(db, f.org, tx => tx.operationTaskEvidence.count({ where: { taskId: f.task.id } }))).toBe(0);
  });
  it.skipIf(!url)("waits for fixed signed PUT leases and forbids shortening or extending a closed upload", async () => {
    const f = await photoFixture(), signedAt = new Date("2026-01-15T10:20:30Z");
    for (const [key, value] of Object.entries({ R2_ACCOUNT_ID: "local-account", R2_BUCKET: "local-bucket", R2_ACCESS_KEY_ID: "local-access", R2_SECRET_ACCESS_KEY: "local-secret" })) vi.stubEnv(key, value);
    try {
      const signed = await signFieldUploadPart(f.ctx, { ...f.request, index: 0 }, { ...deps(), now: signedAt });
      expect(new URL(signed.url).searchParams.get("X-Amz-Date")).toBe("20260115T102030Z");
      expect(new URL(signed.url).searchParams.get("X-Amz-Expires")).toBe("900");
    } finally { vi.unstubAllEnvs(); }
    await Promise.all([signFieldUploadPart(f.ctx, { ...f.request, index: 1 }, { ...deps(), storage: f.storage, now: new Date(signedAt.getTime() + 2) }),
      signFieldUploadPart(f.ctx, { ...f.request, index: 0 }, { ...deps(), storage: f.storage, now: new Date(signedAt.getTime() + 1) })]);
    const expiresAt = new Date(signedAt.getTime() + 2 + temporaryPartLeaseMilliseconds);
    expect((await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }))).partUploadExpiresAt).toEqual(expiresAt);
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: f.upload.uploadId }, data: { partUploadExpiresAt: signedAt } }))).rejects.toThrow(/lease/u);
    const transport = photoTransport((url, options) => options?.method === "PUT" ? new Response(null, { status: 200 }) :
      new Response(new Uint8Array(f.chunks[Number(url.pathname.split("part-").at(-1))]), { status: 200 }));
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    const remove = vi.fn<(part: TemporaryUploadPart) => Promise<void>>().mockResolvedValue(undefined), cleanup = { ...deps(), storage: { deleteTemporaryUploadPart: remove } };
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date(expiresAt.getTime() - 1) })).toEqual({ cleaned: 0 });
    expect(remove).not.toHaveBeenCalled();
    await expect(withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).cleaned(f.upload.uploadId, signedAt))).rejects.toThrow(/lease/u);
    await expect(withTenant(db, f.org, tx => tx.operationEvidenceUpload.update({ where: { id: f.upload.uploadId }, data: { partUploadExpiresAt: new Date(expiresAt.getTime() + 1) } }))).rejects.toThrow(/lease/u);
    await expect(signFieldUploadPart(f.ctx, { ...f.request, index: 0 }, { ...deps(), storage: f.storage })).rejects.toBeInstanceOf(ReservationConflictError);
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: expiresAt })).toEqual({ cleaned: 1 });
    expect(remove.mock.calls.map(call => call[0])).toEqual(f.chunks.map((_, index) => ({ organizationId: f.org, uploadId: f.upload.uploadId, index })));
  });
  it.skipIf(!url)("recovers a lost DELETE acknowledgement and concurrent cleanup without deleting permanent evidence or duplicating attachment", async () => {
    const f = await photoFixture(), other = await photoFixture(), signedAt = new Date("2026-01-15T10:20:30Z"), objects = new Map<string, Uint8Array>();
    for (let index = 0; index < f.chunks.length; index++) {
      await signFieldUploadPart(f.ctx, { ...f.request, index }, { ...deps(), now: signedAt, storage: f.storage });
      objects.set(`${f.org}/uploads/${f.upload.uploadId}/part-${index}`, new Uint8Array(f.chunks[index]));
    }
    const transport = photoTransport((url, options) => {
      const key = url.pathname.slice(1);
      if (options?.method === "PUT") { objects.set(key, new Uint8Array(options.body as Uint8Array)); return new Response(null, { status: 200 }); }
      const bytes = objects.get(key); return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
    });
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    let loseAck = true;
    const remove = vi.fn(({ organizationId, uploadId, index }: TemporaryUploadPart) => Promise.resolve().then(() => {
      expect(organizationId).toBe(f.org); expect(uploadId).toBe(f.upload.uploadId);
      objects.delete(`${organizationId}/uploads/${uploadId}/part-${index}`);
      if (loseAck) { loseAck = false; throw Error("private-storage-diagnostic"); }
    }));
    const cleanup = { ...deps(), storage: { deleteTemporaryUploadPart: remove } };
    expect(await cleanupFieldUploadParts(other.org, cleanup)).toEqual({ cleaned: 0 }); expect(remove).not.toHaveBeenCalled();
    await expect(cleanupFieldUploadParts(f.org, cleanup)).rejects.toThrow(/^Temporary upload cleanup unavailable$/u);
    expect((await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }))).cleanedAt).toBeNull();
    const results = await Promise.all([cleanupFieldUploadParts(f.org, cleanup), cleanupFieldUploadParts(f.org, cleanup)]);
    expect(results.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1);
    expect(objects.size).toBe(1); expect(objects.get(`${f.org}/tasks/${f.task.id}/uploads/${f.upload.uploadId}`)).toEqual(new Uint8Array(f.bytes));
    expect(await cleanupFieldUploadParts(f.org, cleanup)).toEqual({ cleaned: 0 });
    expect(await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport })).toEqual({ uploadId: f.upload.uploadId, status: "READY" });
    const batch = syncPushInputSchema.parse({ ...f.request, op_schema_version: 1, ops: [{ client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: f.task.id, uploadId: f.upload.uploadId } }] });
    expect((await pushSyncOps(f.ctx, batch, deps())).results[0].status).toBe("APPLIED");
    expect((await pushSyncOps(f.ctx, batch, deps())).results[0].status).toBe("DUPLICATE");
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.task.id } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.evidence.attached" } })).toBe(1);
      expect(await tx.syncOp.count({ where: { status: "APPLIED" } })).toBe(1);
      expect(await tx.operationEvidenceUpload.count({ where: { id: other.upload.uploadId } })).toBe(0);
    });
  });
  it.skipIf(!url)("preserves open work and gives pre-lease closed uploads the complete legacy signature window", async () => {
    const f = await photoFixture(), remove = vi.fn().mockResolvedValue(undefined), cleanup = { ...deps(), storage: { deleteTemporaryUploadPart: remove } };
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date("2099-01-01") })).toEqual({ cleaned: 0 });
    await withTenant(db, f.org, tx => new FieldUploadRepository(tx, f.org).cancel(f.upload.uploadId));
    const cancelled = await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }));
    expect(cancelled.partUploadExpiresAt).toBeNull();
    const boundary = cancelled.updatedAt.getTime() + temporaryPartLeaseMilliseconds;
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date(boundary - 1) })).toEqual({ cleaned: 0 }); expect(remove).not.toHaveBeenCalled();
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, now: new Date(boundary + 1) })).toEqual({ cleaned: 1 });
    const retained = await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }));
    expect(retained.status).toBe("CANCELLED"); expect(retained.manifestHash).toBe(cancelled.manifestHash); expect(retained.cleanedAt).not.toBeNull();
  });
  it.skipIf(!url)("rotates a failed bounded cleanup behind other eligible uploads and recovers it later", async () => {
    const f = await photoFixture(), signedAt = new Date("2026-01-15T10:20:30Z");
    const second = await startFieldUpload(f.ctx, { ...f.input, manifest: { ...f.manifest, localId: randomUUID() } }, deps());
    const secondRequest = { ...f.request, uploadId: second.uploadId };
    const transport = photoTransport((url, options) => options?.method === "PUT" ? new Response(null, { status: 200 }) :
      new Response(new Uint8Array(f.chunks[Number(url.pathname.split("part-").at(-1))]), { status: 200 }));
    for (const request of [f.request, secondRequest]) {
      await signFieldUploadPart(f.ctx, { ...request, index: 0 }, { ...deps(), storage: f.storage, now: signedAt });
      await completeFieldUpload(f.ctx, request, { ...deps(), storage: f.storage, transport });
    }
    let unavailable = true;
    const remove = vi.fn(({ uploadId }: TemporaryUploadPart) => Promise.resolve().then(() => { if (unavailable && uploadId === f.upload.uploadId) throw Error("private transport detail"); }));
    const cleanup = { ...deps(), storage: { deleteTemporaryUploadPart: remove } };
    await expect(cleanupFieldUploadParts(f.org, { ...cleanup, limit: 1 })).rejects.toThrow(/^Temporary upload cleanup unavailable$/u);
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, limit: 1 })).toEqual({ cleaned: 1 });
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } })).cleanedAt).toBeNull();
      expect((await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: second.uploadId } })).cleanedAt).not.toBeNull();
    });
    unavailable = false; expect(await cleanupFieldUploadParts(f.org, cleanup)).toEqual({ cleaned: 1 });
  });
  it.skipIf(!url)("defers work beyond the transport budget without deleting open data or losing the pending cleanup", async () => {
    const f = await photoFixture(), signedAt = new Date("2026-01-15T10:20:30Z");
    await signFieldUploadPart(f.ctx, { ...f.request, index: 0 }, { ...deps(), storage: f.storage, now: signedAt });
    const transport = photoTransport((url, options) => options?.method === "PUT" ? new Response(null, { status: 200 }) :
      new Response(new Uint8Array(f.chunks[Number(url.pathname.split("part-").at(-1))]), { status: 200 }));
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    const remove = vi.fn<(part: TemporaryUploadPart) => Promise<void>>().mockResolvedValue(undefined);
    let clock = -30000;
    const cleanup = { ...deps(), storage: { deleteTemporaryUploadPart: remove } };
    expect(await cleanupFieldUploadParts(f.org, { ...cleanup, clock: () => clock += 30000 })).toEqual({ cleaned: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect((await withTenant(db, f.org, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: f.upload.uploadId } }))).cleanedAt).toBeNull();
    expect(await cleanupFieldUploadParts(f.org, cleanup)).toEqual({ cleaned: 1 });
  });
  it.skipIf(!url)("retains separate photo and proxy effects when one native device batch is delivered concurrently", async () => {
    const f = await photoFixture(); f.ctx.authContext.permissions = new Set(["task:view", "task:edit", "task:validate"]);
    const transport = photoTransport((url, options) => options?.method === "PUT" ? new Response(null, { status: 200 }) :
      new Response(new Uint8Array(f.chunks[Number(url.pathname.split("part-").at(-1))]), { status: 200 }));
    await completeFieldUpload(f.ctx, f.request, { ...deps(), storage: f.storage, transport });
    const colleague = await withTenant(db, f.org, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Person-only mixed batch performer" } });
      return tx.operationTask.create({ data: { organizationId: f.org, propertyId: f.property.id, assignedToPersonId: person.id, assignedToUserAccountId: null,
        type: "INSPECTION", state: "ASSIGNED", dueDate: f.task.dueDate, titleTranslations: { en: "Mixed batch colleague" }, idempotencyKey: randomUUID(),
        checklistItems: { create: { organizationId: f.org, key: "ready", labelTranslations: { en: "Ready" }, sortOrder: 0 } } }, include: { checklistItems: true } });
    });
    const batch = syncPushInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, device_id: f.input.device_id, op_schema_version: 1, ops: [
      { client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: f.task.id, uploadId: f.upload.uploadId } },
      { client_op_id: randomUUID(), type: "field_task.proxy_validate", payload: { taskId: colleague.id, expectedVersion: colleague.version,
        performedByPersonId: colleague.assignedToPersonId, checklistItemIds: colleague.checklistItems.map(item => item.id), reason: "Separate colleague review in the same retained device batch" } }
    ] });
    const results = await Promise.all(Array.from({ length: 6 }, () => pushSyncOps(f.ctx, batch, deps())));
    for (const index of [0, 1]) {
      expect(results.filter(row => row.results[index].status === "APPLIED")).toHaveLength(1);
      expect(results.filter(row => row.results[index].status === "DUPLICATE")).toHaveLength(5);
    }
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.task.id, createdBy: f.account.id } })).toBe(1);
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ state: "ASSIGNED", completedAt: null });
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: colleague.id } })).toMatchObject({ state: "COMPLETED", completionSource: "PROXY",
        completedByPersonId: colleague.assignedToPersonId, completedByUserAccountId: null, validatedByUserAccountId: f.account.id });
      expect(await tx.syncOp.count({ where: { deviceId: batch.device_id, status: "APPLIED" } })).toBe(2);
      expect(await tx.auditLog.count({ where: { resourceId: f.task.id, action: "task.evidence.attached" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: colleague.id, action: "task.proxy_validation.created" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted" } })).toBe(0);
    });
  });
});
