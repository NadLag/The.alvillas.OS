import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openCompensationApiFixture } from "./support/compensation-api";

const preview = z.object({ kind: z.string(), amount: z.object({ amount: z.string(), currency: z.string() }), personId: z.uuid(),
  compensationId: z.uuid(), taskId: z.uuid().optional(), completionEventId: z.uuid().optional(), performedByPersonId: z.uuid().optional(), completionMethod: z.string().optional() });
const failure = z.object({ error: z.string() }).strict(), path = "/api/finance/compensation/preview";
test.use({ serviceWorkers: "allow", timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Private compensation API binds completed work and expires actual salary authority in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL required");
  test.setTimeout(120000);
  const f = await openCompensationApiFixture(page, info, locale), origin = new URL(page.url()).origin;
  const anonymous = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  try {
    const { source, rate, facts, original } = f;
    const contract = { kind: "contract", input: { assignmentId: source.assignment.id, earnedAt: new Date().toISOString(), basis: { mode: "PER_JOB", jobs: "3" } } };
    const unauthorized = await anonymous.request.post(path, { headers: { origin }, data: contract });
    expect(unauthorized.status()).toBe(401); expect(failure.parse(await unauthorized.json())).toEqual({ error: "unauthorized" });
    const contractResponse = await page.request.post(path, { headers: { origin }, data: contract });
    expect(contractResponse.status()).toBe(200); expect(contractResponse.headers()["cache-control"]).toBe("private, no-store");
    expect(preview.parse(await contractResponse.json())).toMatchObject({ kind: "CONTRACTUAL_ESTIMATE", compensationId: rate.id, amount: { amount: "1500.75", currency: "MAD" } });
    const injectedActor = await page.request.post(path, { headers: { origin }, data: { ...contract, organizationId: "00000000-0000-4000-8000-000000000001" } });
    expect(injectedActor.status()).toBe(400); expect(failure.parse(await injectedActor.json())).toEqual({ error: "validation" });
    for (const check of await page.getByTestId("field-checklist-item").all()) await check.check();
    await page.getByTestId("field-task-complete").click();
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId }, select: { state: true } }).then(row => row.state))).toBe("COMPLETED");
    const request = { kind: "completed_work", input: { taskId: f.taskId, assignmentId: source.assignment.id, confirmedAssignment: true } };
    const result = await page.request.post(path, { headers: { origin }, data: request });
    expect(result.status()).toBe(200); expect(result.headers()["cache-control"]).toBe("private, no-store");
    const data = preview.parse(await result.json());
    expect(data).toMatchObject({ kind: "COMPLETED_JOB_ESTIMATE", taskId: f.taskId, performedByPersonId: source.account.personId,
      compensationId: rate.id, amount: { amount: "500.25", currency: "MAD" } });
    const completed = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }));
    expect(data.completionMethod).toBe(completed.completionSource);
    expect(await withTenant(f.db, f.organizationId, tx => tx.operationTaskEvent.findUniqueOrThrow({ where: { id: data.completionEventId! } }))).toMatchObject({ taskId: f.taskId, actorId: source.account.id });
    const crossOrigin = await page.request.post(path, { headers: { origin: "https://foreign.example" }, data: request });
    expect(crossOrigin.status()).toBe(403); expect(failure.parse(await crossOrigin.json())).toEqual({ error: "forbidden" });
    const unconfirmed = await page.request.post(path, { headers: { origin }, data: { kind: "completed_work", input: { ...request.input, confirmedAssignment: false } } });
    expect(unconfirmed.status()).toBe(400); expect(failure.parse(await unconfirmed.json())).toEqual({ error: "validation" });
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.update({ where: { id: source.assignment.id }, data: { validTo: new Date() } }));
    const denied = await page.request.post(path, { headers: { origin }, data: request });
    expect(denied.status()).toBe(403); expect(failure.parse(await denied.json())).toEqual({ error: "forbidden" });
    expect(await facts()).toBe(original);
  } finally { await anonymous.close(); await f.db.$disconnect(); }
});
