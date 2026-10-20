import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };
import {
  e2eEmail,
  ensureE2EAdmin,
  waitForE2EAdminLoginWindow,
  completeE2EAdminMfa,
} from "./support/auth";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";

import { execFileSync } from "node:child_process";

const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
test.use({ actionTimeout: 30000, navigationTimeout: 30000 });
for (const locale of ["en", "fr", "ar"] as const)
  test(`Automation create, activate, preview, event, history and pause/resume in ${locale}`, async ({
    page,
  }, info) => {
    test.skip(
      !process.env.DATABASE_URL,
      "DATABASE_URL is required for automation browser acceptance",
    );
    test.setTimeout(180000);
    const t = { en, fr, ar }[locale].Automation,
      email = e2eEmail(`aut-${locale}`, info.project.name),
      key = `browser-${randomUUID().slice(0, 8)}`;
    await ensureE2EAdmin(email, password);
    const db = new PrismaClient(),
      org = bootstrapOrganizationId;
    const fixture = await withTenant(db, org, async (tx) => {
      const account = await tx.userAccount.findFirstOrThrow({
        where: { organizationId: org, email },
      });
      const property = await tx.property.create({
        data: {
          organizationId: org,
          name: `Automation ${key}`,
          addressLine1: "Test",
          city: "Marrakech",
          propertyType: "VILLA",
          bedrooms: 2,
          bathrooms: 2,
          maxGuests: 4,
          amenities: [],
          photoUrls: [],
        },
      });
      const reservation = await tx.reservation.create({
        data: {
          organizationId: org,
          propertyId: property.id,
          reference: key,
          source: "MANUAL",
          status: "CONFIRMED",
          guestName: "Test",
          nights: 7,
          checkIn: new Date("2027-04-10"),
          checkOut: new Date("2027-04-17"),
          createdBy: account.id,
          idempotencyKey: randomUUID(),
        },
      });
      await new ConfigRuleRepository(tx, org).createVersion({
        key: "ops.checklists",
        scopeType: "property",
        scopeId: property.id,
        effectiveFrom: new Date("2020-01-01"),
        value: {
          checklists: [
            {
              key: "inspection",
              name: { en: "Inspection", fr: "Inspection" },
              items: [
                {
                  key: "ready",
                  label: {
                    en: "Confirm readiness",
                    fr: "Confirmer la préparation",
                  },
                },
              ],
            },
          ],
        },
        reason: "Browser automation checklist",
      });
      return { property, reservation };
    });
    try {
      await page.goto("/en/login");
      await waitForE2EAdminLoginWindow(page, email);
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await completeE2EAdminMfa(page, email);
      await expect(page).toHaveURL(/\/en\/app/u);
      if (info.project.name === "field-mobile")
        await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(`/${locale}/app/automations`);
      await expect(
        page.getByRole("heading", { name: t.title, exact: true }),
      ).toBeVisible();
      const form = page.getByTestId("automation-create-form");
      await form.locator('[name="key"]').fill(key);
      await form
        .locator('[name="propertyId"]')
        .selectOption(fixture.property.id);
      await form.getByLabel(t.nameEn).fill(`Inspection ${key}`);
      await form.getByLabel(t.nameFr).fill(`Contrôle ${key}`);
      await form.getByLabel(t.conditions, { exact: true }).fill('{"all":[]}');
      await form.getByLabel(t.actions, { exact: true }).fill(
        JSON.stringify([
          {
            key: "inspection",
            type: "create_task",
            task_type: "INSPECTION",
            title: { en: `Inspection ${key}`, fr: `Contrôle ${key}` },
            due: { from: "reservation.check_in", offset_days: -1 },
            priority: "HIGH",
            checklist_template: "inspection",
          },
        ]),
      );
      await form
        .locator('[name="reason"]')
        .fill("Configure arrival inspection");
      await form.getByRole("button", { name: t.save, exact: true }).click();
      await expect(form.getByRole("status")).toHaveText(t.messages.saved);
      let row = page
        .getByTestId("automation-rule")
        .filter({ hasText: `automation.rule.${key}` });
      await expect(
        row.getByRole("heading", {
          name: locale === "fr" ? `Contrôle ${key}` : `Inspection ${key}`,
          exact: true,
        }),
      ).toBeVisible();
      await row
        .locator('form:has(input[value="state"]) input[name="reason"]')
        .fill("Activate reviewed inspection rule");
      await row.getByRole("button", { name: t.activate, exact: true }).click();
      await expect(
        row.getByText(t.active, { exact: false }).first(),
      ).toBeVisible();
      const event = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "tests/e2e/support/automation-worker.cts",
            org,
            fixture.reservation.id,
            "source",
          ],
          { env: process.env, encoding: "utf8" },
        ),
      ) as { id: string; type: string };
      await page.reload();
      row = page
        .getByTestId("automation-rule")
        .filter({ hasText: `automation.rule.${key}` });
      await row.locator('[name="eventId"]').selectOption(event.id);
      await row.getByRole("button", { name: t.preview, exact: true }).click();
      await expect(row.getByTestId("automation-preview")).toContainText(
        t.matched,
      );
      expect(
        await withTenant(db, org, (tx) =>
          tx.operationTask.count({
            where: { propertyId: fixture.property.id },
          }),
        ),
      ).toBe(0);
      const runWorker = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--import",
              "tsx",
              "tests/e2e/support/automation-worker.cts",
              org,
              event.id,
              event.type,
            ],
            { env: process.env, encoding: "utf8" },
          ),
        ) as { ids: string[]; statuses: string[] };
      const first = runWorker();
      expect(first.ids).toHaveLength(1);
      expect(first.statuses).toEqual(["SUCCEEDED"]);
      expect(runWorker()).toEqual(first);
      expect(
        await withTenant(db, org, (tx) =>
          tx.operationTask.count({
            where: { propertyId: fixture.property.id },
          }),
        ),
      ).toBe(1);
      await page.reload();
      await expect(
        page
          .getByTestId("automation-run")
          .filter({ hasText: `automation.rule.${key}` }),
      ).toContainText(t.statuses.SUCCEEDED);
      row = page
        .getByTestId("automation-rule")
        .filter({ hasText: `automation.rule.${key}` });
      await row
        .locator('form:has(input[value="state"]) input[name="reason"]')
        .fill("Pause reviewed inspection rule");
      await row.getByRole("button", { name: t.pause, exact: true }).click();
      await expect(
        row.getByRole("button", { name: t.resume, exact: true }),
      ).toBeVisible();
      await row
        .locator('form:has(input[value="state"]) input[name="reason"]')
        .fill("Resume reviewed inspection rule");
      await row.getByRole("button", { name: t.resume, exact: true }).click();
      await expect(
        row.getByRole("button", { name: t.pause, exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => document.activeElement?.tagName),
      ).not.toBe("BODY");
      expect(
        (
          await new AxeBuilder({ page })
            .include('[data-testid="automation-page"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.locator("html").getAttribute("dir")).toBe(
        locale === "ar" ? "rtl" : "ltr",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });
