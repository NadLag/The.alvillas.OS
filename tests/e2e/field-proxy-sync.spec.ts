import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, request, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";
import { fieldPullResultSchema } from "@/modules/reservations/domain/field-pull";

test("Queued supervisor HTTP retries retain one reviewed validation and reject changed attribution", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required for queued supervisor HTTP acceptance");
  test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Supervisor fixtures require local PostgreSQL");
  const f = await openFieldFixture(page, info, "en", { checklistItems: 2 });
  try {
    const session = z.object({ user: z.object({ id: z.uuid(), personId: z.uuid(), organizationId: z.uuid() }) })
      .parse(await (await page.request.get("/api/auth/session")).json());
    const person = await withTenant(f.db, f.organizationId, async tx => {
      const worker = await tx.person.create({ data: { organizationId: f.organizationId, displayName: `HTTP colleague ${randomUUID().slice(0, 8)}` } });
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: worker.id, assignedToUserAccountId: null } });
      return worker;
    });
    await page.goto(`/en/app/field/validate/${f.taskId}`);
    const form = page.getByTestId("field-proxy-form"); await expect(form).toBeVisible();
    const payload = { taskId: f.taskId, expectedVersion: Number(await form.locator('[name="expectedVersion"]').inputValue()),
      performedByPersonId: await form.locator('[name="performedByPersonId"]').inputValue(),
      checklistItemIds: await form.getByRole("checkbox").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)),
      reason: "Reviewed colleague work retained for reliable synchronization" };
    expect(payload.performedByPersonId).toBe(person.id);
    const task = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId }, select: { propertyId: true } }));
    const pullParams = new URLSearchParams({ organization_id: session.user.organizationId, actor_user_id: session.user.id, mode: "supervised", property_id: task.propertyId });
    const response = await page.request.get(`/api/sync/pull?${pullParams}`); expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie");
    const initial = fieldPullResultSchema.parse(await response.json()); expect(initial.tasks).toHaveLength(1);
    expect(initial.tasks[0]).toMatchObject({ id: f.taskId, canEdit: false, proxyValidation: { expectedVersion: payload.expectedVersion, performedByPersonId: person.id } });
    for (const key of ["guestEmail", "guestPhone", "financialSnapshot", "balance", "commission"]) expect(initial.tasks[0]).not.toHaveProperty(key);
    const wrongAudience = new URLSearchParams(pullParams); wrongAudience.set("mode", "assigned"); wrongAudience.set("cursor", initial.cursor);
    expect((await page.request.get(`/api/sync/pull?${wrongAudience}`)).status()).toBe(400);
    const op = { client_op_id: randomUUID(), type: "field_task.proxy_validate", payload, client_created_at: new Date().toISOString() };
    const batch = { device_id: randomUUID(), organization_id: session.user.organizationId, actor_user_id: session.user.id, op_schema_version: 1, ops: [op] };
    const result = z.object({ results: z.array(z.object({ status: z.string(), error_code: z.string().optional() })) });
    const post = (data: unknown) => page.request.post("/api/sync/push", { data, headers: { Origin: "http://127.0.0.1:3000" } });
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(batch)));
    for (const response of responses) expect(response.status()).toBe(200);
    const applied = await Promise.all(responses.map(async response => result.parse(await response.json()).results[0]));
    expect(applied.filter(item => item.status === "APPLIED")).toHaveLength(1); expect(applied.filter(item => item.status === "DUPLICATE")).toHaveLength(5);
    const replay = await post(batch); expect(result.parse(await replay.json()).results[0].status).toBe("DUPLICATE");
    const changed = await post({ ...batch, ops: [{ ...op, payload: { ...payload, reason: "Changed original review after successful synchronization" } }] });
    expect(result.parse(await changed.json()).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
    const forged = await post({ ...batch, actor_user_id: randomUUID() });
    expect(result.parse(await forged.json()).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_SESSION_CHANGED" });
    const attributed = await post({ ...batch, ops: [{ ...op, client_op_id: randomUUID(), payload: { ...payload, validatedByUserAccountId: session.user.id } }] });
    expect(attributed.status()).toBe(400);
    const anonymous = await request.newContext({ baseURL: "http://127.0.0.1:3000" });
    try {
      expect((await anonymous.post("/api/sync/push", { data: batch })).status()).toBe(401);
      expect((await anonymous.get(`/api/sync/pull?${pullParams}`)).status()).toBe(401);
    } finally { await anonymous.dispose(); }
    pullParams.set("cursor", initial.cursor); pullParams.set("only_known", "1"); pullParams.set("known_tasks", `${f.taskId}.${initial.tasks[0].revision}`);
    const removed = fieldPullResultSchema.parse(await (await page.request.get(`/api/sync/pull?${pullParams}`)).json());
    expect(removed.tombstones).toEqual([f.taskId]); expect(removed.tasks).toEqual([]); expect(removed.known_changes).toEqual([]);
    await page.reload(); await expect(page.getByTestId("field-proxy-completed")).toBeVisible(); await expect(page.getByTestId("field-proxy-form")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ state: "COMPLETED", completionSource: "PROXY",
        completedByPersonId: person.id, completedByUserAccountId: null, validatedByPersonId: session.user.personId,
        validatedByUserAccountId: session.user.id, validationReason: payload.reason, completionIdempotencyKey: op.client_op_id });
      expect(await tx.syncOp.count({ where: { deviceId: batch.device_id, clientOpId: op.client_op_id, status: "APPLIED" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.proxy_validation.created" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(0);
    });
  } finally { await f.db.$disconnect(); }
});
