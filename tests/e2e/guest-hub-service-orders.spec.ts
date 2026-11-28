import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { formatCurrencyAmount, formatRecipeQuantity } from "@/i18n/format";
import { ownedChefMenu } from "../support/chef-menu-definition";
import ar from "../../messages/ar.json" with { type: "json" };

async function openGuestOrders(page: Page, kind: "service" | "chef" | "grocery" | "transfer") {
  const fixture = z.object({ token: z.string().min(1), serviceKey: z.string().min(1) }).strict().parse(JSON.parse(execFileSync(process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "tests/e2e/support/guest-service-order-fixture-worker.cts", kind],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 })));
  const visited = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/guest-hub/visit");
  await page.goto(`/ar/guest#${fixture.token}`, { waitUntil: "domcontentloaded" });
  expect((await visited).status()).toBe(200);
  await page.waitForURL(/\/ar\/guest\/[a-f0-9-]{36}$/u);
  const orders = page.getByTestId("guest-service-order-entry");
  await expect(orders).toBeVisible();
  return { orders, serviceKey: fixture.serviceKey };
}

test("an Arabic Guest Hub capability orders an approved native service", async ({ page, context, request }) => {
  test.setTimeout(150000);
  const { orders, serviceKey } = await openGuestOrders(page, "service");
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
  await service.selectOption(serviceKey);
  await expect(service).toHaveValue(serviceKey);
  const quantity = orders.getByLabel(ar.GuestServiceOrders.quantity, { exact: true });
  await quantity.fill("2");
  const review = orders.getByTestId("guest-service-order-review");
  const total = formatCurrencyAmount("ar", "240.00", "MAD");
  const requestReview = async () => {
    const reviewed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/service-orders/review"));
    await orders.getByRole("button", { name: ar.GuestServiceOrders.review }).click();
    expect((await reviewed).status()).toBe(200);
    await expect(review.getByText(total, { exact: true })).toBeVisible();
  };
  await requestReview();
  await review.getByRole("button", { name: ar.GuestServiceOrders.edit }).click();
  await expect(quantity).toHaveValue("2");
  await requestReview();
  await review.getByRole("checkbox", { name: ar.GuestServiceOrders.acknowledge }).check();
  const admitted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/service-orders/admit"));
  await review.getByRole("button", { name: ar.GuestServiceOrders.submit }).click();
  expect((await admitted).status()).toBe(200);
  const receipt = orders.getByTestId("guest-service-order-receipt");
  await expect(receipt.getByText(ar.GuestServiceOrders.received, { exact: true })).toBeVisible();
  await expect(receipt.getByText(ar.GuestServiceOrders.orderState.REQUESTED, { exact: true })).toBeVisible();
  await expect(receipt.getByText(total, { exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(orders).toHaveCount(0);
});

test("an Arabic guest can review an approved Chef menu with its listed allergens", async ({ page }) => {
  test.setTimeout(150000);
  const { orders, serviceKey } = await openGuestOrders(page, "chef");
  await orders.getByRole("button", { name: ar.GuestServiceOrders.browse }).click();
  await expect(orders.getByRole("combobox", { name: ar.GuestServiceOrders.service, exact: true })).toHaveValue(serviceKey);
  const menu = orders.getByTestId("guest-chef-menu");
  await expect(menu.getByText(ar.GuestServiceOrders.chefMenu.servingsPerUnit, { exact: true })).toBeVisible();
  await expect(menu.getByText(ownedChefMenu.ingredients[0].name.ar, { exact: true })).toBeVisible();
  await expect(menu.getByText(ownedChefMenu.allergens[0].name.ar, { exact: true })).toBeVisible();
  await expect(orders.getByText(ownedChefMenu.preparation.ar, { exact: true })).toHaveCount(0);
  await orders.getByRole("button", { name: ar.GuestServiceOrders.review }).click();
  const review = orders.getByTestId("guest-service-order-review");
  await expect(review.getByText(formatCurrencyAmount("ar", "120.00", "MAD"), { exact: true })).toBeVisible();
  await expect(review.getByTestId("guest-chef-menu").getByText(ownedChefMenu.allergens[0].name.ar, { exact: true })).toBeVisible();
});

test("an Arabic guest can submit exact grocery quantities with purchase instructions", async ({ page }) => {
  test.setTimeout(150000);
  const { orders } = await openGuestOrders(page, "grocery");
  await orders.getByRole("button", { name: ar.GuestServiceOrders.browse }).click();
  const editor = orders.getByTestId("grocery-items-editor");
  await editor.getByRole("button", { name: ar.Groceries.add, exact: true }).click();
  const unit = "كيلوغرام";
  const quantity = formatRecipeQuantity("ar", "0.100001");
  await editor.getByLabel(ar.Groceries.name, { exact: true }).fill("طماطم");
  await editor.getByLabel(ar.Groceries.quantity, { exact: true }).fill(quantity);
  await editor.getByLabel(ar.Groceries.unit, { exact: true }).fill(unit);
  await editor.getByLabel(ar.Groceries.notes, { exact: true }).fill("طماطم كاملة");
  await orders.getByRole("button", { name: ar.GuestServiceOrders.review }).click();
  const review = orders.getByTestId("guest-service-order-review");
  const items = review.getByTestId("grocery-items");
  await expect(items.getByText(quantity + " " + unit, { exact: true })).toBeVisible();
  await expect(items.getByText("طماطم كاملة", { exact: true })).toBeVisible();
  await review.getByRole("checkbox", { name: ar.GuestServiceOrders.acknowledge }).check();
  await review.getByRole("button", { name: ar.GuestServiceOrders.submit }).click();
  await expect(orders.getByTestId("guest-service-order-receipt").getByText(ar.GuestServiceOrders.orderState.REQUESTED, { exact: true })).toBeVisible();
});

test("an Arabic guest books one property-local transfer pickup", async ({ page }) => {
  test.setTimeout(150000);
  const { orders } = await openGuestOrders(page, "transfer");
  await orders.getByRole("button", { name: ar.GuestServiceOrders.browse }).click();
  const fields = orders.getByTestId("transfer-request-fields");
  await fields.getByLabel(ar.Transfers.pickup, { exact: true }).fill("باب المطار");
  await fields.getByLabel(ar.Transfers.destination, { exact: true }).fill("مدخل الحديقة");
  await fields.getByLabel(ar.Transfers.pickupTime, { exact: true }).fill("14:35");
  await fields.getByLabel(ar.Transfers.flightReference, { exact: true }).fill("SYN-2031");
  await expect(orders.getByLabel(ar.GuestServiceOrders.pickupDate, { exact: true })).toHaveValue("2031-05-01");
  await expect(orders.getByLabel(ar.GuestServiceOrders.lastServiceDate, { exact: true })).toHaveCount(0);
  await orders.getByRole("button", { name: ar.GuestServiceOrders.review }).click();
  const review = orders.getByTestId("guest-service-order-review");
  const pickup = review.getByTestId("transfer-details");
  await expect(pickup.getByText("باب المطار", { exact: true })).toBeVisible();
  await expect(pickup.locator("time")).toHaveAttribute("datetime", "2031-05-01T14:35");
  await expect(pickup.getByText("(Africa/Casablanca)", { exact: true })).toBeVisible();
  await expect(review.getByText(formatCurrencyAmount("ar", "120.00", "MAD"), { exact: true })).toBeVisible();
  await expect(pickup.getByText(ar.Transfers.cashHelp, { exact: true })).toHaveCount(0);
  await review.getByRole("checkbox", { name: ar.GuestServiceOrders.acknowledge }).check();
  await review.getByRole("button", { name: ar.GuestServiceOrders.submit }).click();
  await expect(orders.getByTestId("guest-service-order-receipt").getByText(ar.GuestServiceOrders.orderState.REQUESTED, { exact: true })).toBeVisible();
});
