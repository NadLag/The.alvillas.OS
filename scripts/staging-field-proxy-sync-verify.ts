import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request, expect as playwrightExpect } from "@playwright/test";
import { z } from "zod";
import { fieldPullResultSchema } from "../src/modules/reservations/domain/field-pull";

const expect = playwrightExpect.configure({ timeout: 30000 }), origin = "https://the-alvillas-os-staging.vercel.app";
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE), file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const fixture = z.object({ organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid(), taskId: z.uuid(), workerPersonId: z.uuid(),
  propertyName: z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u) })
  .parse(JSON.parse(await readFile(z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE), "utf8")));
const context = await request.newContext({ baseURL: origin, storageState: state, timeout: 30000 }), anonymous = await request.newContext({ baseURL: origin });
try {
  expect(await (await context.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(await (await context.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId, organizationId: fixture.organizationId,
    personId: fixture.actorPersonId, securitySetupRequired: false } });
  const query = new URLSearchParams({ organization_id: fixture.organizationId, actor_user_id: fixture.actorId, mode: "supervised" });
  const response = await context.get(`/api/sync/pull?${query}`); expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("private"); expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers().vary.toLowerCase()).toContain("cookie");
  const initial = fieldPullResultSchema.parse(await response.json()), seen = new Set<string>();
  let page = initial, pages = 0;
  while (true) {
    expect(page.organization_id).toBe(fixture.organizationId); expect(page.actor_user_id).toBe(fixture.actorId);
    for (const task of page.tasks) {
      expect(seen.has(task.id)).toBe(false); seen.add(task.id);
      expect(task.propertyName).toBe(fixture.propertyName); expect(task.canEdit).toBe(false);
      expect(task.proxyValidation).toBeDefined(); expect(task.proxyValidation?.performedByPersonId).not.toBe(fixture.actorPersonId);
      expect(task.id).not.toBe(fixture.taskId);
    }
    pages += 1; if (!page.next_cursor) break; if (pages > 100) throw new Error("Bounded staging pagination exceeded");
    query.set("cursor", page.next_cursor); page = fieldPullResultSchema.parse(await (await context.get(`/api/sync/pull?${query}`)).json());
  }
  const wrongAudience = new URLSearchParams(query); wrongAudience.set("cursor", initial.cursor); wrongAudience.set("mode", "assigned");
  expect((await context.get(`/api/sync/pull?${wrongAudience}`)).status()).toBe(400);
  const forgedActor = new URLSearchParams(query); forgedActor.set("actor_user_id", randomUUID()); forgedActor.delete("cursor");
  expect((await context.get(`/api/sync/pull?${forgedActor}`)).status()).toBe(403);
  const foreignTenant = new URLSearchParams(query); foreignTenant.set("organization_id", randomUUID()); foreignTenant.delete("cursor");
  expect((await context.get(`/api/sync/pull?${foreignTenant}`)).status()).toBe(403);
  expect((await anonymous.get(`/api/sync/pull?${query}`)).status()).toBe(401);
  query.delete("cursor"); query.set("only_known", "1"); query.set("known_tasks", `${fixture.taskId}.-`);
  const removed = fieldPullResultSchema.parse(await (await context.get(`/api/sync/pull?${query}`)).json());
  expect(removed.tasks).toEqual([]); expect(removed.known_changes).toEqual([]); expect(removed.tombstones).toEqual([fixture.taskId]);
  const invalid = await context.post("/api/sync/push", { headers: { Origin: origin }, data: {
    device_id: `staging-schema-denial-${randomUUID()}`, organization_id: fixture.organizationId, actor_user_id: fixture.actorId, op_schema_version: 1,
    ops: [{ client_op_id: randomUUID(), type: "field_task.proxy_validate", payload: { taskId: fixture.taskId, expectedVersion: 1,
      performedByPersonId: fixture.workerPersonId, validatedByPersonId: fixture.actorPersonId, checklistItemIds: [randomUUID()], reason: "Client validator identity is forbidden" } }]
  } });
  expect(invalid.status()).toBe(400);
  expect((await context.get(`/__alvillas_e2e/network/${randomUUID()}`)).status()).toBe(404);
  expect(await (await context.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  await writeFile(file, JSON.stringify({ sha, origin, authenticated: true, completed: true, pages, scopedTasks: seen.size, privateNoStore: true,
    actorAndTenantDenied: true, audienceBoundCursor: true, completedProxyTombstone: true, clientValidatorDenied: true,
    nativeTaskMutations: 0, nativeQueuedClientAcceptancePending: true }, null, 2));
  console.log(JSON.stringify({ sha, authenticatedSupervisedProjection: true, scopedPages: pages, nativeTaskMutations: 0 }));
} catch { throw new Error("Authenticated staging projection verification incomplete; no native task was submitted"); }
finally { await context.dispose(); await anonymous.dispose(); }
