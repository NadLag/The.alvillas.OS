import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { Webhook } from "svix";
import { withTenant } from "@/platform/db/tenant";
import { deliverEmail } from "@/platform/notifications/email-delivery-service";
import { EmailRequestError } from "@/platform/providers/real";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa } from "./support/auth";

test.describe("notification delivery diagnostics", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for delivery diagnostics E2E");
  test("shows durable attempts and signed bounces, masks sensitive data and queues bounded retries with accessible localized states", async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const email = e2eEmail(`delivery-${Date.now()}`, testInfo.project.name); const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(email, password);
    await page.goto("/en/login"); await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email); await expect(page).toHaveURL(/\/(en|fr)\/app$/u);
    if (testInfo.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    const session = await (await page.request.get("/api/auth/session")).json() as { user: { id: string; organizationId: string } };
    const organizationId = session.user.organizationId; const db = new PrismaClient(); const rows: { id: string; providerId: string; scenario: string }[] = [];
    try {
      for (const scenario of ["retry", "bounce", "permanent", "delivered"]) {
        const recipient = scenario === "bounce" ? await withTenant(db, organizationId, async tx => {
          const person = await tx.person.create({ data: { organizationId, displayName: "PRIVATE bounced recipient" } });
          return tx.userAccount.create({ data: { organizationId, personId: person.id, email: `bounced-${email}` } });
        }) : { id: session.user.id, email };
        const event = await withTenant(db, organizationId, tx => tx.outboxEvent.create({ data: { organizationId, type: "identity.recovery.delivery_requested", idempotencyKey: crypto.randomUUID(), payload: {
          userAccountId: recipient.id, channel: "email", toEmail: recipient.email, locale: "en", recoveryCode: "PRIVATE-recovery-code", recoveryUrl: "http://localhost:3000/en/recover", expiresAt: new Date(Date.now() + 3600000).toISOString()
        } } }));
        const providerId = crypto.randomUUID();
        const attempt = deliverEmail(event, { db, now: new Date(Date.now() - 120000), env: { APP_URL: "http://localhost:3000", EMAIL_FROM: "ops@example.test" },
          provider: { send: () => scenario === "retry" ? Promise.reject(new EmailRequestError(429)) : scenario === "permanent" ? Promise.reject(new EmailRequestError(401)) : Promise.resolve({ id: providerId }) } });
        if (["retry", "permanent"].includes(scenario)) await expect(attempt).rejects.toThrow(/^email_delivery_(retry|failed)$/u); else await attempt;
        const delivery = await withTenant(db, organizationId, tx => tx.notificationDelivery.findFirstOrThrow({ where: { eventId: event.id } }));
        rows.push({ id: delivery.id, providerId, scenario });
      }
      const foreign = await db.organization.create({ data: { name: "PRIVATE foreign diagnostics" } });
      const foreignDelivery = await withTenant(db, foreign.id, async tx => {
        const person = await tx.person.create({ data: { organizationId: foreign.id, displayName: "PRIVATE foreign recipient" } });
        const account = await tx.userAccount.create({ data: { organizationId: foreign.id, personId: person.id, email: "private-foreign@example.test" } });
        const event = await tx.outboxEvent.create({ data: { organizationId: foreign.id, type: "identity.recovery.delivery_requested", payload: {}, idempotencyKey: crypto.randomUUID() } });
        return tx.notificationDelivery.create({ data: { organizationId: foreign.id, userAccountId: account.id, eventId: event.id, deliveryKey: "email", channel: "email", kind: "identity.recovery.delivery_requested", status: "FAILED", providerId: "PRIVATE foreign provider" } });
      });
      // Real HTTP route + vendor signatures + real PostgreSQL; only the send
      // transport is replaced in this local browser test.
      const secret = process.env.RESEND_WEBHOOK_SECRET; expect(secret).toBeTruthy();
      for (const row of rows.filter(row => ["bounce", "delivered"].includes(row.scenario))) {
        const at = new Date(); const id = `msg_${crypto.randomUUID()}`;
        const body = JSON.stringify({ type: row.scenario === "bounce" ? "email.bounced" : "email.delivered", created_at: at.toISOString(), data: { email_id: row.providerId,
          to: [email], subject: "PRIVATE SUBJECT", bounce: { type: "Permanent", message: "PRIVATE SMTP DETAILS" }, tags: { template: "identity_recovery", organization_id: organizationId, delivery_id: row.id } } });
        const headers = { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret!).sign(id, at, body) };
        expect((await page.request.post("/api/webhooks/resend", { data: body, headers: { ...headers, "svix-signature": "v1,invalid" } })).status()).toBe(401);
        for (let i = 0; i < 2; i++) expect((await page.request.post("/api/webhooks/resend", { data: body, headers })).status()).toBe(200);
      }
      await page.goto("/en/app/notifications"); const panel = page.getByTestId("delivery-settings"); await expect(panel).toBeVisible();
      await page.getByTestId("delivery-channel").selectOption("email");
      const bounced = panel.locator(`[data-delivery-id="${rows.find(row => row.scenario === "bounce")!.id}"]`);
      const bouncedId = rows.find(row => row.scenario === "bounce")!.id; let forged = false;
      await page.route("**/en/app/notifications", async route => {
        const body = route.request().postData();
        if (!forged && route.request().method() === "POST" && body?.includes(bouncedId)) {
          forged = true; const response = await route.fetch({ postData: body.replaceAll(bouncedId, foreignDelivery.id) });
          const responseBody = await response.text(); expect(responseBody).not.toContain("PRIVATE"); expect(responseBody).not.toContain("private-foreign@example.test"); await route.fulfill({ response });
        } else await route.continue();
      });
      await bounced.getByRole("button", { name: "View delivery history" }).click(); await expect(panel.getByRole("alert")).toBeVisible(); expect(forged).toBe(true);
      await page.unrouteAll({ behavior: "wait" });
      await expect(bounced).toContainText("Bounced"); await bounced.getByRole("button", { name: "View delivery history" }).click(); await expect(bounced).toContainText("Permanent bounce"); await expect(bounced.getByTestId("delivery-retry")).toHaveCount(0);
      const pending = panel.locator(`[data-delivery-id="${rows.find(row => row.scenario === "retry")!.id}"]`);
      await pending.getByRole("button", { name: "View delivery history" }).click(); await page.getByTestId("delivery-reason").fill("Recheck provider availability");
      await page.getByTestId("delivery-retry").focus(); await page.keyboard.press("Enter"); await expect(panel.getByRole("status")).toContainText("Retry queued");
      await page.getByTestId("delivery-refresh").click(); await expect(panel).toHaveAttribute("aria-busy", "false");
      for (const locale of ["en", "fr", "ar"]) {
        await page.goto(`/${locale}/app/notifications`); await expect(panel.getByTestId("delivery-row").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await panel.innerText()).not.toMatch(/PRIVATE|example.test|recovery-code/u);
        for (const row of rows) expect(await panel.innerText()).not.toContain(row.providerId);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      await page.goto("/en/app/notifications"); await expect(panel.getByTestId("delivery-row").first()).toBeVisible();
      await page.context().setOffline(true); await expect(panel.getByRole("status")).toContainText("offline"); await expect(page.getByTestId("delivery-refresh")).toBeDisabled(); await page.context().setOffline(false);
      await page.route("**/en/app/notifications", route => route.request().method() === "POST" ? route.abort("failed") : route.continue());
      await page.getByTestId("delivery-refresh").click(); await expect(panel.getByRole("alert")).toBeVisible();
      await page.unrouteAll({ behavior: "wait" }); await page.getByTestId("delivery-refresh").click(); await expect(panel.getByRole("alert")).toHaveCount(0);
    } finally { await db.$disconnect(); }
  });
  test("requires authentication before revealing delivery diagnostics", async ({ page }) => {
    await page.goto("/fr/app/notifications"); await expect(page).toHaveURL(/\/fr\/login$/u); await expect(page.getByTestId("delivery-settings")).toHaveCount(0);
  });
});
