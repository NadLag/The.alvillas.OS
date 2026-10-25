import enMessages from "../../messages/en.json" with { type: "json" };
import frMessages from "../../messages/fr.json" with { type: "json" };
import arMessages from "../../messages/ar.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  e2eEmail,
  ensureE2EAdmin,
  completeE2EAdminMfa,
  waitForE2EAdminLoginWindow,
} from "./support/auth";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { preferOperationPerformer } from "./support/operation-policy";

const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
test.use({ actionTimeout: 30000, navigationTimeout: 30000 });
for (const locale of ["en", "fr", "ar"] as const)
  test(`Operations lifecycle, checklist, proxy history and accessibility in ${locale}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.DATABASE_URL,
      "DATABASE_URL is required for Operations browser acceptance",
    );
    test.setTimeout(180000);
    const email = e2eEmail(`ops-${locale}`, testInfo.project.name),
      suffix = randomUUID().slice(0, 8);
    await test.step("enroll administrator through the security panel", () =>
      ensureE2EAdmin(email, password));
    const db = new PrismaClient(),
      org = bootstrapOrganizationId;
    const fixture = await withTenant(db, org, async (tx) => {
      const property = await tx.property.create({
        data: {
          organizationId: org,
          name: `Operations ${suffix}`,
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
      const worker = await tx.person.create({
        data: { organizationId: org, displayName: `Operator ${suffix}` },
      });
      const workerAccount = await tx.userAccount.create({
        data: { organizationId: org, personId: worker.id },
      });
      await new ConfigRuleRepository(tx, org).createVersion({
        key: "ops.checklists",
        scopeType: "property",
        scopeId: property.id,
        reason: "Browser checklist fixture",
        effectiveFrom: new Date("2020-01-01"),
        value: {
          checklists: [
            {
              key: "inspection",
              name: { en: "Inspection", fr: "Inspection", ar: "الفحص" },
              items: [
                {
                  key: "ready",
                  label: {
                    en: "Verify readiness",
                    fr: "Vérifier la préparation",
                    ar: "التحقق من الجاهزية",
                  },
                },
              ],
            },
          ],
        },
      });
      const role = await tx.role.findFirstOrThrow({
        where: { organizationId: org, key: "field_staff" },
      });
      await tx.roleAssignment.create({
        data: {
          organizationId: org,
          personId: worker.id,
          userAccountId: workerAccount.id,
          roleId: role.id,
          scopeType: "property",
          scopeId: property.id,
          validFrom: new Date("2020-01-01"),
        },
      });
      return { property, worker, workerAccount };
    });
    try {
      console.info(
        JSON.stringify({
          operationsStep: "login",
          locale,
          project: testInfo.project.name,
        }),
      );
      await page.goto("/en/login");
      await waitForE2EAdminLoginWindow(page, email);
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await completeE2EAdminMfa(page, email);
      await expect(page).toHaveURL(/\/en\/app/u);
      await page.goto(
        `/${locale}/app/operations/new?propertyId=${fixture.property.id}`,
      );
      console.info(
        JSON.stringify({
          operationsStep: "create-task",
          locale,
          project: testInfo.project.name,
          path: new URL(page.url()).pathname,
        }),
      );
      const form = page.getByTestId("operation-create-form");
      await form.locator('[name="type"]').selectOption("LAUNDRY");
      await form.locator('[name="titleEn"]').fill(`Laundry ${suffix}`);
      await form.locator('[name="titleFr"]').fill(`Blanchisserie ${suffix}`);
      await form.locator('[name="dueDate"]').fill("2027-04-10");
      await form
        .locator('[name="reason"]')
        .fill("Prepare the next guest arrival");
      await form.locator('button[type="submit"]').click();
      await expect(page.getByTestId("operation-detail-page")).toBeVisible();
      const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
      await expect(page.getByTestId("task-history-event")).toHaveCount(1);
      console.info(
        JSON.stringify({
          operationsStep: "assign-fixture",
          locale,
          project: testInfo.project.name,
        }),
      );
      const assign = page.getByTestId("operation-assign-form");
      await assign.locator('[name="personId"]').selectOption(fixture.worker.id);
      await assign
        .locator('[name="reason"]')
        .fill("Assign this task to the available operator");
      await assign.locator('button[type="submit"]').click();
      await expect(page.getByTestId("operation-proxy-form")).toBeVisible();
      const reschedule = page.getByTestId("operation-reschedule-form");
      await reschedule.locator('[name="startTime"]').fill("14:00");
      await reschedule
        .locator('[name="reason"]')
        .fill("Reschedule before the next guest arrival");
      await reschedule.locator('button[type="submit"]').click();
      await expect(reschedule.getByRole("status")).toBeVisible();
      const scheduled = await withTenant(db, org, (tx) =>
        tx.operationTask.findUniqueOrThrow({ where: { id: taskId } }),
      );
      expect(scheduled).toMatchObject({
        state: "ASSIGNED",
        assignedToPersonId: fixture.worker.id,
      });
      const proxy = page.getByTestId("operation-proxy-form");
      console.info(
        JSON.stringify({
          operationsStep: "proxy-completion",
          locale,
          project: testInfo.project.name,
          path: new URL(page.url()).pathname,
        }),
      );
      await proxy.locator('[name="checklistItemIds"]').check();
      await proxy.locator('[name="reason"]').fill("Worker unable to use phone");
      await proxy.locator('button[type="submit"]').click();
      await expect(page.getByTestId("task-performed-by")).toHaveAttribute(
        "data-person-id",
        fixture.worker.id,
      );
      const account = await withTenant(db, org, (tx) =>
        tx.userAccount.findFirstOrThrow({
          where: { organizationId: org, email },
        }),
      );
      await expect(page.getByTestId("task-validated-by")).toHaveAttribute(
        "data-person-id",
        account.personId,
      );
      await expect(page.getByTestId("task-history-event")).toHaveCount(5);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      console.info(
        JSON.stringify({
          operationsStep: "accessibility-verified",
          locale,
          project: testInfo.project.name,
        }),
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (locale === "ar")
        await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const evidence = page.getByTestId("operation-evidence-form");
      await evidence
        .locator('[name="reason"]')
        .fill("Inspection evidence recorded during the task");
      await evidence.locator('button[type="submit"]').click();
      await expect(
        page
          .getByTestId("task-evidence-panel")
          .getByText("Inspection evidence recorded during the task", {
            exact: true,
          }),
      ).toBeVisible();
      const issue = page.getByTestId("operation-issue-form");
      await issue.locator('[name="title"]').fill(`Pool issue ${suffix}`);
      await issue
        .locator('[name="reason"]')
        .fill("Pool filter needs a maintenance inspection");
      await issue.locator('button[type="submit"]').click();
      await expect(
        page
          .getByTestId("task-evidence-panel")
          .getByText(`Pool issue ${suffix}`, { exact: true }),
      ).toBeVisible();
      for (const view of ["LIST", "TIMELINE", "DAY", "WEEK", "MONTH"]) {
        await page.goto(
          `/${locale}/app/operations?propertyId=${fixture.property.id}&date=2027-04-10&view=${view}`,
        );
        await expect(page.getByTestId("operation-task-count")).toBeVisible();
        await expect(
          page.getByTestId("operation-task-title").first(),
        ).toBeVisible();
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
      await page.goto(
        `/${locale}/app/operations?propertyId=${fixture.property.id}&view=LIST&type=LAUNDRY`,
      );
      await page
        .locator("details")
        .filter({ has: page.getByTestId("operation-save_view-form") })
        .locator("summary")
        .click();
      const savedView = page.getByTestId("operation-save_view-form");
      await savedView.locator('[name="name"]').fill(`My laundry ${suffix}`);
      await savedView.locator('button[type="submit"]').click();
      await expect(
        page.getByRole("link", { name: `My laundry ${suffix}`, exact: true }),
      ).toBeVisible();
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Casablanca",
      }).format(new Date(Date.now() + 86400000));
      await preferOperationPerformer(email, fixture.property.name);
      await page.goto(
        `/${locale}/app/operations/recurring?propertyId=${fixture.property.id}`,
      );
      const series = page.getByTestId("operation-series-form");
      await series.locator('[name="type"]').selectOption("POOL");
      await series.locator('[name="titleEn"]').fill(`Daily pool ${suffix}`);
      await series
        .locator('[name="titleFr"]')
        .fill(`Piscine quotidienne ${suffix}`);
      await series.locator('[name="startsOn"]').fill(today);
      await series.locator('[name="endsOn"]').fill(today);
      await series.locator('[name="everyDays"]').fill("1");
      for (const box of await series.locator('[name="weekdays"]').all())
        await box.check();
      await series.locator('[name="startTime"]').fill("16:00");
      await series
        .locator('[name="reason"]')
        .fill("Daily pool maintenance schedule");
      await series.locator('button[type="submit"]').click();
      await expect(
        page.getByRole("link", {
          name:
            locale === "fr"
              ? `Piscine quotidienne ${suffix}`
              : `Daily pool ${suffix}`,
          exact: true,
        }),
      ).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.goto(
        `/${locale}/app/operations?propertyId=${fixture.property.id}&type=POOL&date=${today}`,
      );
      await page
        .locator("details")
        .filter({ has: page.getByTestId("operation-recurring-form") })
        .locator("summary")
        .click();
      const generate = page.getByTestId("operation-recurring-form");
      await generate.locator('[name="from"]').fill(today);
      await generate.locator('[name="until"]').fill(today);
      await generate.locator('button[type="submit"]').click();
      await expect(page.getByTestId("operation-task-row")).toHaveCount(1);
      const catalog = { en: enMessages, fr: frMessages, ar: arMessages }[locale]
        .Operations;
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: catalog.title,
          exact: true,
        }),
      ).toBeVisible();
      const bulk = page.getByTestId("operation-bulk-form");
      await bulk.locator('[name="items"]').check();
      await bulk.locator('[name="bulkAction"]').selectOption("PRIORITY");
      await bulk.locator('[name="priority"]').selectOption("URGENT");
      await bulk
        .locator('[name="reason"]')
        .fill("Prioritize pool readiness before check-in");
      await bulk.locator('button[type="submit"]').click();
      await expect(bulk.getByRole("status")).toHaveText(catalog.manage.saved);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const generated = await withTenant(db, org, (tx) =>
        tx.operationTask.findFirstOrThrow({
          where: {
            organizationId: org,
            propertyId: fixture.property.id,
            type: "POOL",
          },
        }),
      );
      expect(generated.priority).toBe("URGENT");
      expect(generated.assignedToUserAccountId).toBe(account.id);
      await page.goto(`/${locale}/app/field/${generated.id}`);
      const field = page.getByTestId("field-task-complete-form");
      await expect(page.getByTestId("field-task-complete")).toBeDisabled();
      for (const item of await field.locator('[name="checklistItemIds"]').all())
        await item.check();
      await field.locator('[data-progress="true"]').click();
      await expect(field.getByTestId("field-task-progress-status")).toHaveText(catalog.manage.saved);
      const fieldEvidence = page.getByTestId("operation-evidence-form");
      await fieldEvidence
        .locator('[name="reason"]')
        .fill(`Field checklist evidence ${suffix}`);
      await fieldEvidence.locator('button[type="submit"]').click();
      await expect(
        page
          .getByTestId("task-evidence-panel")
          .getByText(`Field checklist evidence ${suffix}`, { exact: true }),
      ).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const fieldCatalog = { en: enMessages, fr: frMessages, ar: arMessages }[
        locale
      ].Field;
      await expect(page.getByTestId("field-task-complete")).toHaveText(
        fieldCatalog.complete,
      );
      await page.getByTestId("field-task-complete").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
      const selfCompleted = await withTenant(db, org, (tx) =>
        tx.operationTask.findUniqueOrThrow({ where: { id: generated.id } }),
      );
      expect(selfCompleted).toMatchObject({
        state: "COMPLETED",
        completionSource: "SELF",
        completedByPersonId: account.personId,
        validatedByPersonId: null,
      });
      await page.goto(
        `/${locale}/app/operations?propertyId=${fixture.property.id}&view=LIST`,
      );
      await testInfo.attach(`operations-${locale}`, {
        body: await page.screenshot({
          fullPage: true,
          path: `.tmp/operations-${testInfo.project.name}-${locale}.png`,
        }),
        contentType: "image/png",
      });
      console.info(
        JSON.stringify({
          operationsStep: "screenshot-attached",
          locale,
          project: testInfo.project.name,
        }),
      );
    } finally {
      await db.$disconnect();
    }
  });
