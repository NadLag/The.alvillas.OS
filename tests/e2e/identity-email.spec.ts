import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ensureE2EAdmin, e2eEmail } from "./support/auth";
import { authContextForAccount } from "@/modules/identity/application/identity-access";
import { createInvitation, issueRecoveryCode } from "@/modules/identity/application/identity-service";
import { bootstrapOrganizationId as org } from "@/platform/identity/bootstrap";
import { withTenant } from "@/platform/db/tenant";
import { renderIdentityEmail } from "@/platform/email/identity-templates";
import { hashRateLimitKey } from "@/platform/rate-limit/postgres-rate-limiter";

test("localized identity email links activate and recover once with expiry and rate limits", async ({ page }, testInfo) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required");
  test.setTimeout(240000);
  const db = new PrismaClient();
  const adminEmail = e2eEmail(`email-admin-${randomUUID()}`, testInfo.project.name);
  const password = "correct horse email acceptance staple";
  try {
    await ensureE2EAdmin(adminEmail, password);
    const admin = await withTenant(db, org, tx => tx.userAccount.findFirstOrThrow({ where: { email: adminEmail } }));
    const actor = { organizationId: org, actorId: admin.id, personId: admin.personId, authContext: await authContextForAccount(org, admin.id, { db }) };
    for (const locale of ["en", "fr", "ar"] as const) {
      const email = e2eEmail(`email-${locale}-${randomUUID()}`, testInfo.project.name);
      const phone = `+2126${String(Date.now()).slice(-8)}`;
      const invitation = await createInvitation(actor, { displayName: `Email acceptance ${locale}`, email, phone, preferredLocale: locale, roleKey: "field_staff", scopeType: "organization", expiresInHours: 1 }, { db, origin: "http://127.0.0.1:3000" });
      const event = await withTenant(db, org, tx => tx.outboxEvent.findFirstOrThrow({ where: { idempotencyKey: `identity.invitation.delivery:${invitation.invitationId}` } }));
      const rendered = renderIdentityEmail(event.type, event.payload, "http://127.0.0.1:3000");
      expect(rendered.locale).toBe(locale);
      const link = /href="([^"]+)"/u.exec(rendered.html)![1];
      await page.goto(link);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await page.getByTestId("activation-phone").fill(phone);
      await page.getByTestId("activation-pin").fill("654321");
      await page.getByTestId("activation-password").fill(password);
      await page.getByTestId("activation-submit").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
      await page.goto(link);
      await page.getByTestId("activation-phone").fill(phone);
      await page.getByTestId("activation-pin").fill("654321");
      await page.getByTestId("activation-submit").click();
      await expect(page.getByTestId("identity-form-error")).toBeVisible();
      const account = await withTenant(db, org, tx => tx.userAccount.findFirstOrThrow({ where: { email } }));
      const code = await issueRecoveryCode(actor, account.id, { db, origin: "http://127.0.0.1:3000" });
      await page.goto(`/${locale}/recover`);
      await page.getByTestId("recovery-email").fill(email);
      await page.getByTestId("recovery-code-input").fill("invalid-recovery-code");
      await page.getByTestId("recovery-password").fill(password + " recovered");
      await expect(page.getByTestId("recovery-password")).toHaveAttribute("type", "password");
      await page.getByTestId("recovery-submit").click();
      await expect(page.getByTestId("identity-form-error")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByTestId("recovery-email").fill(email);
      await page.getByTestId("recovery-code-input").fill(code);
      await page.getByTestId("recovery-password").fill(password + " recovered");
      await page.getByTestId("recovery-submit").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(password + " recovered");
      await page.getByTestId("login-submit").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/app/?$`, "u"));
      await page.context().clearCookies();
      const expiryRequest = randomUUID();
      const expiredCode = await issueRecoveryCode(actor, account.id, { db, requestId: expiryRequest });
      await withTenant(db, org, async tx => {
        const audit = await tx.auditLog.findFirstOrThrow({ where: { requestId: expiryRequest, action: "identity.recovery_code.issue" } });
        await tx.authCredential.update({ where: { id: (audit.after as { authCredentialRecordId: string }).authCredentialRecordId }, data: { expiresAt: new Date(0) } });
      });
      const elapsedWindow = Date.now() % 60000;
      if (elapsedWindow > 45000) await page.waitForTimeout(60100 - elapsedWindow);
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.goto(`/${locale}/recover`);
        await page.getByTestId("recovery-email").fill(email);
        await page.getByTestId("recovery-code-input").fill(attempt === 0 ? expiredCode : code);
        await page.getByTestId("recovery-password").fill(password + " must not change");
        await page.getByTestId("recovery-submit").click();
        await expect(page.getByTestId("identity-form-error")).toBeVisible();
      }
      const outcomes = await withTenant(db, org, async tx => ({
        activation: await tx.auditLog.count({ where: { resourceId: account.id, action: "identity.invitation.accept" } }),
        recovery: await tx.auditLog.count({ where: { resourceId: account.id, action: "identity.account.recover" } }),
        buckets: await tx.rateLimitBucket.findMany({ where: { keyHash: { in: ["127.0.0.1", "::1", "::ffff:127.0.0.1", "local"].map(ip => hashRateLimitKey(`recovery:${email}:${ip}`)) }, windowSeconds: 60, count: { gte: 6 } } })
      }));
      expect(outcomes.activation).toBe(1); expect(outcomes.recovery).toBe(1); expect(outcomes.buckets.length).toBeGreaterThan(0);
    }
  } finally { await db.$disconnect(); }
});
