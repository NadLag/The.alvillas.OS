import { writeFile } from "node:fs/promises";
import { request, expect } from "@playwright/test";
import { z } from "zod";
import { fieldPullResultSchema, type FieldWorkSnapshot } from "../src/modules/reservations/domain/field-pull";

const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const propertyId = z.uuid().parse(process.env.STAGING_FIELD_PROPERTY_ID);
const completedTaskId = z.uuid().parse(process.env.STAGING_FIELD_COMPLETED_TASK_ID);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const evidenceFile = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const origin = "https://the-alvillas-os-staging.vercel.app";
const context = await request.newContext({ baseURL: origin, storageState: state });
const anonymous = await request.newContext({ baseURL: origin });
try {
  expect(await (await context.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  const session = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) })
    .parse(await (await context.get("/api/auth/session")).json());
  const params = new URLSearchParams({ organization_id: session.user.organizationId, actor_user_id: session.user.id, mode: "assigned", property_id: propertyId });
  const path = () => `/api/sync/pull?${params}`;
  expect((await anonymous.get(path())).status()).toBe(401);
  let cursor: string | null = null, checkpoint = "", pages = 0;
  const rows: FieldWorkSnapshot[] = [];
  do {
    if (cursor) params.set("cursor", cursor);
    const response = await context.get(path()); expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie");
    const result = fieldPullResultSchema.parse(await response.json());
    expect(result.organization_id).toBe(session.user.organizationId); expect(result.actor_user_id).toBe(session.user.id);
    rows.push(...result.tasks); cursor = result.next_cursor; checkpoint = result.cursor; expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(rows.length).toBeGreaterThan(0); expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  for (const row of rows) {
    expect(row.propertyId).toBe(propertyId); expect(row.propertyName).toMatch(/^Automation acceptance aut-[a-f0-9]{8}$/u);
    for (const field of ["guestEmail", "guestPhone", "balance", "commission", "financialSnapshot"]) expect(row).not.toHaveProperty(field);
  }
  params.set("cursor", checkpoint); params.set("only_known", "1");
  params.set("known_tasks", rows.slice(0, 49).map(row => `${row.id}.${row.revision}`).concat(`${completedTaskId}.-`).join(","));
  const unchanged = fieldPullResultSchema.parse(await (await context.get(path())).json());
  expect(unchanged.tasks).toEqual([]); expect(unchanged.known_changes).toEqual([]); expect(unchanged.tombstones).toEqual([completedTaskId]);
  params.set("actor_user_id", crypto.randomUUID()); expect((await context.get(path())).status()).toBe(403);
  params.set("actor_user_id", session.user.id); params.set("organization_id", crypto.randomUUID()); expect((await context.get(path())).status()).toBe(403);
  params.set("organization_id", session.user.organizationId); params.set("known_tasks", `${completedTaskId}.bad.extra`); expect((await context.get(path())).status()).toBe(400);
  params.delete("known_tasks"); params.set("cursor", checkpoint + "tampered"); expect((await context.get(path())).status()).toBe(400);
  await writeFile(evidenceFile, JSON.stringify({ sha, origin, completed: true, authenticated: true, readOnly: true,
    pages, assignedTasks: rows.length, unchangedSnapshotsOmitted: true, terminalTombstone: true, ownershipDenied: true,
    anonymousDenied: true, tamperedCursorDenied: true, privateResponseHeaders: true, financialAndContactFieldsExcluded: true }, null, 2));
  console.log(JSON.stringify({ sha, authenticatedFieldPull: true, readOnly: true, pages, assignedTasks: rows.length }));
} catch { throw new Error("Staging field pull verification failed; no business writes were performed"); }
finally { await context.dispose(); await anonymous.dispose(); }
