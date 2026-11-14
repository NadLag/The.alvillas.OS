import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

test("Inngest authenticates discovery and denies unsigned execution", async ({ request }) => {
  const key = process.env.INNGEST_SIGNING_KEY;
  expect(key).toMatch(/^signkey-test-/u);
  const seconds = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", key!.replace(/^signkey-\w+-/u, "")).update(seconds).digest("hex");
  const discovery = await request.get("/api/inngest", { headers: { "x-inngest-signature": `t=${seconds}&s=${digest}` } });
  expect(discovery.status()).toBe(200);
  // The original nine consumers, document generation and its failure consumer,
  // plus private preparation, explicit distribution, authenticated observation and native activation workers.
  expect(await discovery.json()).toMatchObject({ function_count: 17 });
  const invalidDigest=(digest.startsWith("0")?"1":"0")+digest.slice(1);
  expect((await request.get("/api/inngest",{headers:{"x-inngest-signature":`t=${seconds}&s=${invalidDigest}`}})).status()).toBe(401);
  const response = await request.post("/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { data: {} });
  expect(response.status()).toBe(401);
  expect((await request.get("/api/inngest")).status()).toBe(401);
  const body = await response.text(); expect(body).not.toContain("organizations");
  expect((await request.post("/api/jobs/outbox", { data: {} })).status()).toBe(401);
});
