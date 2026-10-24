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
});
