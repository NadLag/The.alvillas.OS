import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { guestServiceOrderPublicReviewSchema, guestServiceOrderReceiptSchema } from "@/platform/services/guest-service-order-contracts";
import ar from "../../messages/ar.json" with { type: "json" };

test("an Arabic Guest Hub capability orders an approved native service", async ({ page, context, request }) => {
  test.setTimeout(150000);
  const fixture = z.object({ token: z.string().min(1), serviceKey: z.string().min(1) }).strict().parse(JSON.parse(execFileSync(process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "tests/e2e/support/guest-service-order-fixture-worker.cts"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 })));
  const visited = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/guest-hub/visit");
  await page.goto(`/ar/guest#${fixture.token}`, { waitUntil: "domcontentloaded" });
  expect((await visited).status()).toBe(200);
  await page.waitForURL(/\/ar\/guest\/[a-f0-9-]{36}$/u);
  const orders = page.getByTestId("guest-service-order-entry");
  await expect(orders).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
  const guest = new URL(page.url());
  const linkId = guest.pathname.split("/").at(-1);
  const denied = await request.post(`/api/guest-hub/links/${linkId}/service-orders/view`, { headers: { Origin: guest.origin }, data: {} });
  expect(denied.status()).toBe(404);
  expect(denied.headers()["cache-control"]).toContain("no-store");
  const listed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/service-orders/view"));
  await orders.getByRole("button", { name: ar.GuestServiceOrders.browse }).click();
  expect((await listed).status()).toBe(200);
  const service = orders.getByRole("combobox", { name: ar.GuestServiceOrders.service, exact: true });
  await service.selectOption(fixture.serviceKey);
  await expect(service).toHaveValue(fixture.serviceKey);
  const quantity = orders.getByLabel(ar.GuestServiceOrders.quantity, { exact: true });
  await quantity.fill("2");
  const review = orders.getByTestId("guest-service-order-review");
  const requestReview = async () => {
    const reviewed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/service-orders/review"));
    await orders.getByRole("button", { name: ar.GuestServiceOrders.review }).click();
    expect(guestServiceOrderPublicReviewSchema.parse(await (await reviewed).json()).totalAmount).toBe("240.00");
  };
  await requestReview();
  await review.getByRole("button", { name: ar.GuestServiceOrders.edit }).click();
  await expect(quantity).toHaveValue("2");
  await requestReview();
  await review.getByRole("checkbox", { name: ar.GuestServiceOrders.acknowledge }).check();
  const admitted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/service-orders/admit"));
  await review.getByRole("button", { name: ar.GuestServiceOrders.submit }).click();
  expect(guestServiceOrderReceiptSchema.parse(await (await admitted).json())).toMatchObject({ state: "REQUESTED", totalAmount: "240.00" });
  await expect(orders.getByTestId("guest-service-order-receipt")).toContainText(ar.GuestServiceOrders.received);
  await context.setOffline(true);
  await expect(orders).toHaveCount(0);
});
