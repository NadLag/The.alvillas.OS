import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

test("Inngest authenticates discovery and denies unsigned execution", async ({ request }) => {
  const key = process.env.INNGEST_SIGNING_KEY;
  expect(key).toMatch(/^signkey-test-/u);
  const seconds = String(Math.floor(Date.now() / 1000));
  const signingKey = key!.replace(/^signkey-\w+-/u, "");
  const sign = (body: string) => createHmac("sha256", signingKey).update(body).update(seconds).digest("hex");
  const digest = sign("");
  const discovery = await request.get("/api/inngest", { headers: { "x-inngest-signature": `t=${seconds}&s=${digest}` } });
  expect(discovery.status()).toBe(200);
  expect(await discovery.json()).toMatchObject({ function_count: 21 });

  const registrationBody = JSON.stringify({ url: discovery.url() });
  const registration = await request.put("/api/inngest", {
    data: registrationBody,
    headers: {
      "content-type": "application/json",
      "x-inngest-sync-kind": "in_band",
      "x-inngest-signature": `t=${seconds}&s=${sign(registrationBody)}`
    }
  });
  expect(registration.status()).toBe(200);
  const { functions } = await registration.json() as { functions: unknown[] };
  expect(functions).toHaveLength(21);
  expect(functions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "alvillas-os-reporting-calendar-refresh", triggers: [{ cron: "*/5 * * * *" }] }),
    expect.objectContaining({ id: "alvillas-os-report-scheduled-delivery", triggers: [{ cron: "* * * * *" }] })
  ]));

  const invalidDigest=(digest.startsWith("0")?"1":"0")+digest.slice(1);
  expect((await request.get("/api/inngest",{headers:{"x-inngest-signature":`t=${seconds}&s=${invalidDigest}`}})).status()).toBe(401);
  const response = await request.post("/api/inngest?fnId=alvillas-os-dispatch-outbox&stepId=step", { data: {} });
  expect(response.status()).toBe(401);
  expect((await request.post("/api/inngest?fnId=alvillas-os-native-onboarding-activation&stepId=step",{data:{}})).status()).toBe(401);
  expect((await request.post("/api/inngest?fnId=alvillas-os-native-guest-agreement-signature-admission&stepId=step",{data:{}})).status()).toBe(401);
  expect((await request.get("/api/inngest")).status()).toBe(401);
  const body = await response.text(); expect(body).not.toContain("organizations");
  expect((await request.post("/api/jobs/outbox", { data: {} })).status()).toBe(401);
});
