import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { fieldWalletSnapshotSchema } from "@/modules/identity/domain/field-wallet";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import { maskedValue } from "@/platform/authz/present";
import en from "../../messages/en.json" with { type: "json" };

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Worker wallet requires its own grant and preserves private offline figures in ${locale}`, async ({ page: admin, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required"); test.setTimeout(360000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Wallet fixtures require local PostgreSQL");
  const f = await openFieldFixture(admin, info, "en"), origin = new URL(admin.url()).origin;
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "allow", viewport: { width: info.project.name === "field-mobile" ? 360 : 1440, height: 900 } });
  const page = await context.newPage(), phone = `+21266${randomInt(1_000_000, 10_000_000)}`, pin = "368247", roleKey = `e2e_wallet_${randomUUID().replaceAll("-", "")}`;
  const roleName = `Own wallet viewer ${roleKey.slice(-6)}`;
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await admin.goto("/en/app/identity"); await admin.getByTestId("invite-display-name").fill(`Local wallet employee ${locale}`);
    await admin.getByTestId("invite-phone").fill(phone); await admin.getByTestId("invite-role").selectOption("field_staff");
    await admin.getByTestId("invite-scope-type").selectOption("job"); await admin.getByTestId("invite-scope-id").fill(f.taskId);
    await admin.getByTestId("invite-preferred-locale").selectOption(locale); await admin.getByTestId("invite-submit").click();
    const code = (await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(code).toBeTruthy();
    await page.goto(`/${locale}/activate/${code}`); await page.getByTestId("activation-phone").fill(phone); await page.getByTestId("activation-pin").fill(pin);
    await page.getByTestId("activation-submit").click(); await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await page.goto(`/${locale}/login?surface=field`); await page.getByTestId("login-phone").fill(phone); await page.getByTestId("login-pin").fill(pin);
    await page.getByTestId("login-submit").click(); await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const user = z.object({ user: z.object({ id: z.uuid(), personId: z.uuid(), organizationId: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    expect(user.organizationId).toBe(f.organizationId); expect((await page.request.get("/api/field/wallet")).status()).toBe(403);
    await expect(page.getByTestId("field-wallet-entry")).toHaveCount(0);
    await expect.poll(async () => (await storedFieldData(page, "cacheState")).some(row => Boolean(row && typeof row === "object" && "cursor" in row && row.cursor))).toBe(true);
    await withTenant(f.db, f.organizationId, async tx => {
      const account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id }, include: { authCredentials: true } });
      expect(account.passwordHash).toBeNull(); expect(account.authCredentials.find(row => row.type === "PIN")?.secretHash).toMatch(/^\$argon2id\$/u);
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: user.personId, assignedToUserAccountId: user.id } });
    });
    await admin.goto(`/en/app/team/${user.personId}`);
    await admin.getByText(en.Team.linkWallet, { exact: true }).click();
    const linkForm = admin.getByTestId("team-wallet-form"); await linkForm.locator('[name="ledgerAccountId"]').selectOption("");
    await linkForm.locator('[name="accountName"]').fill(`Dedicated wallet ${locale}`); await linkForm.locator('[name="reason"]').fill("Local own-wallet read acceptance");
    await linkForm.locator('button[type="submit"]').click(); await expect(linkForm.getByRole("status")).toHaveText(en.Team.result.saved, { timeout: 30000 });
    const link = await withTenant(f.db, f.organizationId, tx => tx.teamWallet.findFirstOrThrow({ where: { personId: user.personId } }));
    // These are isolated ledger fixtures for the read surface. Native financial
    // producer acceptance remains a separate mandatory feature dependency.
    await withTenant(f.db, f.organizationId, async tx => {
      const offset = await tx.ledgerAccount.create({ data: { organizationId: f.organizationId, code: `E2E_BANK_${randomUUID().replaceAll("-", "").toUpperCase()}`,
        name: "Isolated wallet fixture offset", accountType: "ASSET", normalSide: "DEBIT" } });
      const fixtures = [{ side: "DEBIT", amount: "1500", currency: "MAD", description: "Fictional advance" }, { side: "CREDIT", amount: "850", currency: "MAD", description: "Fictional property expense" },
        { side: "CREDIT", amount: "200", currency: "MAD", description: "Fictional company expense" }, { side: "DEBIT", amount: "9007199254740991.99", currency: "EUR", description: "Exact decimal display fixture" },
        ...Array.from({ length: 26 }, (_, index) => ({ side: "DEBIT", amount: "1", currency: "MAD", description: `Fictional movement ${index}` }))];
      for (const row of fixtures) await tx.financialTransaction.create({ data: { organizationId: f.organizationId, reference: randomUUID(), occurredAt: new Date(), description: row.description,
        postings: { create: [{ organizationId: f.organizationId, ledgerAccountId: link.ledgerAccountId, side: row.side, amount: row.amount, currency: row.currency },
          { organizationId: f.organizationId, ledgerAccountId: offset.id, side: row.side === "DEBIT" ? "CREDIT" : "DEBIT", amount: row.amount, currency: row.currency }] } } });
    });
    await admin.goto("/en/app/identity"); const roleForm = admin.getByTestId("custom-role-create-form");
    await roleForm.getByTestId("custom-role-name").fill(roleName); await roleForm.getByTestId("custom-role-key").fill(roleKey);
    await roleForm.getByTestId("custom-role-description").fill("Explicit own-wallet read permission, without general financial access");
    await roleForm.locator('input[name="permissionKeys"][value="wallet:view"]').check();
    const created = admin.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/en/app/identity" && Boolean(response.request().postData()?.includes(roleKey)));
    await roleForm.getByTestId("custom-role-submit").click(); expect((await created).ok()).toBe(true);
    await expect(roleForm.getByRole("status")).toHaveText("Custom role created.", { timeout: 30000 });
    const role = await withTenant(f.db, f.organizationId, tx => tx.role.findFirstOrThrow({ where: { key: roleKey } }));
    const assignment = admin.locator("form.role-assignment-form");
    await assignment.getByTestId("assignment-account").selectOption(user.id); await assignment.getByTestId("assignment-role").selectOption(role.id);
    await assignment.getByTestId("assignment-scope-type").selectOption("wallet"); await assignment.getByTestId("assignment-scope-id").fill(link.id);
    await assignment.locator('[name="validFrom"]').fill("2020-01-01"); await assignment.getByTestId("assignment-assigned-to-me").check();
    await assignment.getByTestId("assignment-submit").click();
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.roleAssignment.count({ where: { userAccountId: user.id, roleId: role.id, scopeType: "wallet", scopeId: link.id } }))).toBe(1);
    await expect(assignment.getByTestId("assignment-submit")).toBeEnabled();
    const response = await page.request.get("/api/field/wallet"); expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie");
    const model = fieldWalletSnapshotSchema.parse(await response.json()); expect(model.userId).toBe(user.id);
    expect(model.balances).toContainEqual({ currency: "MAD", amount: "476.00" }); expect(model.balances).toContainEqual({ currency: "EUR", amount: "9007199254740991.99" });
    expect(model.movements).toHaveLength(25); expect(model.hasNext).toBe(true); expect(model.compensationVisible).toBe(false);
    expect((await page.request.get(`/api/field/wallet?personId=${randomUUID()}`)).status()).toBe(400);
    // Exercise the real scope-change cursor rejection while a valid wallet
    // response is in flight. Only transport timing changes; both API responses
    // and the cache reset come from the application and PostgreSQL.
    let releaseCursor!: () => void, cacheReady!: () => void;
    const walletStarted = new Promise<void>(resolve => { releaseCursor = resolve; });
    const refreshedCache = new Promise<void>(resolve => { cacheReady = resolve; });
    let resetObserved = false, heldWallet = false;
    await page.exposeFunction("walletScopeCacheReady", () => { if (resetObserved) cacheReady(); });
    await page.addInitScript(() => window.addEventListener("alvillas-field-cache-ready", () => { void (window as unknown as { walletScopeCacheReady(): Promise<void> }).walletScopeCacheReady(); }));
    await page.route("**/api/sync/pull?**", async route => {
      const response = await route.fetch();
      if (response.status() === 409 && !resetObserved) { resetObserved = true; await walletStarted; }
      await route.fulfill({ response });
    });
    await page.route("**/api/field/wallet?page=1", async route => {
      const response = await route.fetch();
      if (!heldWallet) { heldWallet = true; releaseCursor(); await refreshedCache; }
      await route.fulfill({ response });
    });
    await page.goto(`/${locale}/app/field`); await expect(page.getByTestId("field-wallet-entry")).toBeVisible(); await page.getByTestId("field-wallet-entry").click();
    await expect(page.getByTestId("field-wallet-page")).toBeVisible(); const wallet = page.getByTestId("field-wallet");
    const euro = wallet.getByTestId("field-wallet-balances").getByRole("listitem").filter({ hasText: "EUR" });
    await expect(euro).toContainText(/[.,٫](?:99|٩٩)/u); await expect(wallet.getByTestId("field-wallet-compensation-masked")).toHaveText(maskedValue);
    expect(resetObserved).toBe(true); expect(heldWallet).toBe(true);
    await page.unroute("**/api/sync/pull?**"); await page.unroute("**/api/field/wallet?page=1");
    const balances = wallet.getByTestId("field-wallet-balances");
    await balances.evaluate(element => { (element as HTMLElement).style.fontSize = `${Number.parseFloat(getComputedStyle(element).fontSize) * 2}px`; });
    const overflow = await balances.getByRole("listitem").evaluateAll((elements, viewportWidth) => Math.max(0, ...[...elements, ...elements.flatMap(element => Array.from(element.querySelectorAll("strong")))].flatMap(element => {
      const rectangle = element.getBoundingClientRect(); return [-rectangle.left, rectangle.right - viewportWidth];
    })), page.viewportSize()!.width);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(wallet.getByTestId("field-wallet-movement")).toHaveCount(25); await wallet.getByTestId("field-wallet-next").click();
    await expect(wallet.getByTestId("field-wallet-movement")).toHaveCount(5); await expect(wallet.getByTestId("field-wallet-next")).toBeDisabled();
    await balances.evaluate(element => { (element as HTMLElement).style.fontSize = ""; });
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    const privateCache = await storedFieldData(page, "cacheState"); expect(JSON.stringify(privateCache)).toContain("9007199254740991.99");
    await context.setOffline(true); await page.reload(); await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?view=wallet$`, "u"));
    await expect(euro).toContainText(/[.,٫](?:99|٩٩)/u); await expect(wallet.getByTestId("field-wallet-movement")).toHaveCount(5);
    await expect(wallet.getByTestId("field-wallet-notice")).toBeVisible(); await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const button of await wallet.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    const publicCacheLeak = await page.evaluate(async () => {
      for (const name of await caches.keys()) { const cache = await caches.open(name); for (const request of await cache.keys()) {
        const cached = await cache.match(request); if (cached?.headers.get("content-type")?.includes("text/html") && (await cached.text()).includes("9007199254740991.99")) return true;
      } } return false;
    }); expect(publicCacheLeak).toBe(false);
    await page.screenshot({ path: info.outputPath(`own-wallet-offline-${locale}.png`), fullPage: true });
    await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await admin.goto("/en/app/identity"); const row = admin.getByTestId("role-catalog-row").filter({ hasText: roleName });
    await row.getByText("Edit role").click(); const edit = row.getByTestId("custom-role-edit-form");
    await edit.locator('input[name="permissionKeys"][value="wallet:view"]').uncheck(); await edit.locator('input[name="permissionKeys"][value="task:view"]').check();
    await edit.getByTestId("edit-custom-role-submit").click(); await expect(edit.getByRole("status")).toHaveText("Custom role updated.", { timeout: 30000 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(wallet.getByTestId("field-wallet-balances")).toHaveCount(0);
    await expect.poll(async () => JSON.stringify(await storedFieldData(page, "cacheState"))).not.toContain("9007199254740991.99");
    expect((await page.request.get("/api/field/wallet")).status()).toBe(403);
    expect(await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.count({ where: { postings: { some: { ledgerAccountId: link.ledgerAccountId } } } }))).toBe(30);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); await f.db.$disconnect(); }
});
