import { randomInt } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"]) test(`Field Phone + PIN keypad signs into scoped work in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field PIN sign-in"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Field invitation fixtures require a local database");
  const f = await openFieldFixture(page, info, "en"), phone = `+21264${randomInt(1_000_000, 10_000_000)}`;
  try {
    const original = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }));
    await page.goto("/en/app/identity"); await page.getByTestId("invite-display-name").fill(`Local field keypad ${locale} ${phone.slice(-4)}`);
    await page.getByTestId("invite-phone").fill(phone); await page.getByTestId("invite-role").selectOption("field_staff");
    await page.getByTestId("invite-preferred-locale").selectOption(locale); await page.getByTestId("invite-submit").click();
    const code = (await page.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(code).toBeTruthy();
    await page.goto("/en/app"); await page.getByTestId("logout-button").click(); await expect(page).toHaveURL(/\/en\/login$/u);
    await page.goto(`/${locale}/activate/${code}`); await page.getByTestId("activation-phone").fill(phone); await page.getByTestId("activation-pin").fill("654321");
    await page.getByTestId("activation-submit").click(); await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await page.goto(`/${locale}/login?surface=field`);
    await expect(page.locator('input[name="method"][value="pin"]')).toBeChecked(); await expect(page.getByTestId("login-pin-keypad")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("locale-switch-fr")).toHaveAttribute("href", "/fr/login?surface=field");
    await expect(page.getByTestId("login-pin")).toHaveAttribute("type", "password");
    for (const button of await page.getByTestId("login-pin-keypad").getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    await page.getByTestId("login-phone").fill(phone); await page.getByTestId("pin-key-0").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("login-pin")).toHaveValue("0"); await page.getByTestId("pin-key-clear").click();
    await expect(page.getByTestId("login-pin")).toHaveValue("");
    for (const digit of "654320") await page.getByTestId(`pin-key-${digit}`).click();
    let resume: (() => void) | undefined; const held = new Promise<void>(resolve => { resume = resolve; });
    await page.route(`**/${locale}/login?surface=field`, async route => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page.getByTestId("login-submit").click();
    try {
      await expect(page.getByTestId("login-submit")).toBeDisabled(); await expect(page.getByTestId("login-pin")).toBeDisabled();
      for (const button of await page.getByTestId("login-pin-keypad").getByRole("button").all()) await expect(button).toBeDisabled();
    } finally { resume!(); }
    await expect(page.getByTestId("login-error")).toBeVisible(); await expect(page.getByTestId("login-pin")).toHaveValue(""); await expect(page.getByTestId("login-phone")).toHaveValue(phone);
    await page.unroute(`**/${locale}/login?surface=field`);
    for (const digit of "654329") await page.getByTestId(`pin-key-${digit}`).click();
    await page.getByTestId("pin-key-delete").focus(); await page.keyboard.press("Enter"); await page.getByTestId("pin-key-1").click();
    await expect(page.getByTestId("login-pin")).toHaveValue("654321");
    await page.getByTestId("pin-key-clear").click(); await page.getByTestId("login-pin").fill("٦٥٤٣٢١"); await expect(page.getByTestId("login-pin")).toHaveValue("654321");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`field-pin-${locale}.png`), fullPage: true });
    const arrived = page.waitForURL(new RegExp(`/${locale}/app/field$`, "u"), { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-submit").click(); await arrived; await expect(page.getByTestId("field-page")).toBeVisible();
    const session = z.object({ user: z.object({ id: z.uuid(), personId: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) })
      .parse(await (await page.request.get("/api/auth/session")).json());
    expect(session.user.organizationId).toBe(f.organizationId); expect(session.user.id).not.toBe(original.assignedToUserAccountId);
    expect((await page.request.get(`/${locale}/app/field/${f.taskId}`)).status()).toBe(404);
    const forged = new URLSearchParams({ organization_id: f.organizationId, actor_user_id: original.assignedToUserAccountId!, mode: "assigned" });
    expect((await page.request.get(`/api/sync/pull?${forged}`)).status()).toBe(403);
    await expect.poll(async () => z.array(z.object({ snapshotAt: z.string().optional() })).parse(await storedFieldData(page, "cacheState")).filter(row => row.snapshotAt)).toHaveLength(1);
    expect(await storedFieldData(page, "jobs")).toEqual([]);
    await withTenant(f.db, f.organizationId, tx => tx.operationTask.update({ where: { id: f.taskId }, data: {
      assignedToUserAccountId: session.user.id, assignedToPersonId: session.user.personId, state: "ASSIGNED" } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(1);
    await page.getByTestId("field-view-assigned").click(); await expect(page.getByTestId("field-task-card")).toHaveCount(1);
    await page.getByTestId("field-task-card").click(); await expect(page.getByTestId("field-task-page")).toBeVisible();
    expect(await withTenant(f.db, f.organizationId, tx => tx.authSession.count({ where: { userAccountId: session.user.id, revokedAt: null } }))).toBe(1);
  } finally { await f.db.$disconnect(); }
});
