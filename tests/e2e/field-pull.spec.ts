import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { fieldPullResultSchema } from "@/modules/reservations/domain/field-pull";
import { openFieldFixture } from "./support/field-fixture";

test.use({ serviceWorkers: "allow" });
test("Field pull verifies authenticated ownership, cached revisions and private response headers", async ({ page, playwright }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for authenticated field pull");
  test.setTimeout(180000);
  const fixture = await openFieldFixture(page, info, "en");
  const anonymous = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    const session = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json());
    const params = new URLSearchParams({ organization_id: fixture.organizationId, actor_user_id: session.user.id, mode: "assigned" });
    const endpoint = () => `/api/sync/pull?${params}`;
    expect((await anonymous.get(endpoint())).status()).toBe(401);
    const response = await page.request.get(endpoint()); expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie");
    const payload = fieldPullResultSchema.parse(await response.json());
    expect(payload).toMatchObject({ op_schema_version: 1, organization_id: fixture.organizationId, actor_user_id: session.user.id, next_cursor: null });
    expect(payload.tasks).toHaveLength(1); expect(payload.tasks[0]).toMatchObject({ id: fixture.taskId, canEdit: true });
    for (const field of ["guestEmail", "guestPhone", "commission", "balance", "financialSnapshot"]) expect(payload.tasks[0]).not.toHaveProperty(field);
    params.set("cursor", payload.cursor); params.set("known_tasks", `${fixture.taskId}.${payload.tasks[0].revision}`);
    const unchanged = fieldPullResultSchema.parse(await (await page.request.get(endpoint())).json());
    expect(unchanged.tasks).toEqual([]); expect(unchanged.known_changes).toEqual([]); expect(unchanged.tombstones).toEqual([]);
    params.set("actor_user_id", randomUUID()); expect((await page.request.get(endpoint())).status()).toBe(403);
    params.set("actor_user_id", session.user.id); params.set("known_tasks", `${fixture.taskId}.bad.extra`);
    expect((await page.request.get(endpoint())).status()).toBe(400);
    params.delete("known_tasks"); params.set("cursor", payload.cursor + "tampered"); expect((await page.request.get(endpoint())).status()).toBe(400);
  } finally { await anonymous.dispose(); await fixture.db.$disconnect(); }
});
