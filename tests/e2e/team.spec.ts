import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { withTenant } from "@/platform/db/tenant";
import { hashPassword } from "@/platform/auth/password";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { scheduleTeamDocumentReminders } from "@/modules/identity/application/team-documents";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa } from "./support/auth";

test.describe("Team Management", () => {
  test.use({ actionTimeout: 15000 });
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required");
  test("invites a login for an existing staff profile and preserves its identity and scoped assignment", async ({ page, browser }, info) => {
    test.setTimeout(120000);
    const email = e2eEmail("team-invite-admin", info.project.name), password = "Team invitation verification 2026";
    const name = `Existing staff ${info.project.name} ${randomUUID().slice(0, 8)}`;
    const staffEmail = e2eEmail(`team-invite-${Date.now()}`, info.project.name);
    const phone = `+2126${Date.now().toString().slice(-8)}`;
    await ensureE2EAdmin(email, password);
    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/en\/app$/u);
    await page.goto("/en/app/team");
    await page.locator("summary").filter({ hasText: /^Add person$/u }).click();
    const profile = page.getByTestId("team-profile-form");
    await profile.getByLabel("Full name").fill(name);
    await profile.getByLabel("Email", { exact: true }).fill(staffEmail);
    await profile.getByLabel("Phone", { exact: true }).fill(phone);
    await profile.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(profile.getByRole("status")).toHaveText("Saved.");
    await profile.getByRole("link", { name: "Open profile" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    const personId = new URL(page.url()).pathname.split("/").pop()!;
    const db = new PrismaClient();
    const staffContext = await browser.newContext(info.project.use);
    try {
      const property = await withTenant(db, bootstrapOrganizationId, tx => tx.property.create({ data: { organizationId: bootstrapOrganizationId, name: `${name} villa`, addressLine1: "Test address", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } }));
      await page.getByRole("link", { name: "Invite a login", exact: true }).click();
      await expect(page.getByTestId("invite-person")).toHaveValue(personId);
      for (const [testId, value] of [["invite-display-name", name], ["invite-email", staffEmail], ["invite-phone", phone]]) {
        await expect(page.getByTestId(testId)).toHaveValue(value);
        await expect(page.getByTestId(testId)).toHaveJSProperty("readOnly", true);
      }
      await page.getByTestId("invite-role").selectOption("field_staff");
      await page.getByTestId("invite-scope-type").selectOption("property");
      await page.getByTestId("invite-scope-id").fill(property.id);
      await page.getByTestId("invite-submit").click();
      const code = (await page.getByTestId("invitation-code").innerText()).split(":").pop()!.trim();
      const staff = await staffContext.newPage();
      await staff.goto(`/en/activate/${code}`);
      await staff.getByTestId("activation-phone").fill(phone);
      await staff.getByTestId("activation-pin").fill("654321");
      await staff.getByTestId("activation-submit").click();
      await expect(staff).toHaveURL(/\/en\/login/u);
      await staff.getByRole("radio", { name: "Phone + PIN", exact: true }).check();
      await staff.getByTestId("login-phone").fill(phone);
      await staff.getByTestId("login-pin").fill("654321");
      await staff.getByTestId("login-submit").click();
      await expect(staff).toHaveURL(/\/en\/app$/u);
      const session = await (await staff.request.get("/api/auth/session")).json() as Session;
      expect(session.user.personId).toBe(personId);
      await staff.goto(`/en/app/team/${personId}`);
      await expect(staff.getByRole("heading", { level: 1 })).toHaveText(name);
      await withTenant(db, bootstrapOrganizationId, async tx => {
        expect(await tx.person.count({ where: { email: staffEmail } })).toBe(1);
        const account = await tx.userAccount.findFirstOrThrow({ where: { personId } });
        expect(account).toMatchObject({ email: staffEmail, phone, status: "ACTIVE" });
        expect(await tx.roleAssignment.findFirstOrThrow({ where: { personId, userAccountId: account.id } })).toMatchObject({ scopeType: "property", scopeId: property.id });
      });
      await page.goto(`/en/app/team/${personId}`);
      await expect(page.getByRole("link", { name: "Invite a login", exact: true })).toHaveCount(0);
      const offboard = page.getByTestId("team-offboard-form");
      await offboard.getByLabel("Reason", { exact: true }).fill("Completed isolated staff invitation verification");
      const offboardResponse = page.waitForResponse(response =>
        response.request().method() === "POST" &&
        Boolean(response.request().postData()?.includes("offboard")) &&
        new URL(response.url()).pathname === `/en/app/team/${personId}`
      );
      await offboard.getByRole("button", { name: "Offboard person", exact: true }).click();
      const response = await offboardResponse;
      expect(response.status()).toBe(200);
      // Successful offboarding removes the form during revalidation.
      await expect(page.getByText("Offboarded", { exact: true })).toBeVisible();
      await expect(offboard).toHaveCount(0);
      await withTenant(db, bootstrapOrganizationId, async tx => {
        expect((await tx.person.findFirstOrThrow({ where: { id: personId } })).archivedAt).not.toBeNull();
        expect((await tx.userAccount.findFirstOrThrow({ where: { personId } })).status).toBe("DEACTIVATED");
        expect(await tx.roleAssignment.count({ where: { personId, archivedAt: null } })).toBe(0);
      });
      await staff.goto(`/en/app/team/${personId}`);
      await expect(staff).toHaveURL(/\/en\/login/u);
    } finally {
      await staffContext.close();
      await db.$disconnect();
    }
  });
  test("admin manages staff, scoped roles, compensation history, leave, workload and guarded offboarding; staff data stays private in EN FR RTL", async ({
    page,
    browser
  }, info) => {
    test.setTimeout(240000);
    const email = e2eEmail("team-admin", info.project.name),
      password = "Team verification passphrase 2026";
    await ensureE2EAdmin(email, password);
    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/en\/app$/u);
    await page.getByRole("link", { name: "Team", exact: true }).click();
    await page
      .locator("summary")
      .filter({ hasText: /^Add person$/u })
      .click();
    const name = `Team ${info.project.name} ${randomUUID().slice(0, 8)}`,
      staffEmail = e2eEmail("team-staff", info.project.name);
    const profile = page.getByTestId("team-profile-form");
    await profile.getByLabel("Full name").fill(name);
    await profile.getByLabel("Email", { exact: true }).fill(staffEmail);
    await profile.getByLabel("Phone", { exact: true }).fill("+212600000011");
    await profile.getByRole("button", { name: "Add person", exact: true }).click();
    await expect(profile.getByRole("status")).toHaveText("Saved.");
    await profile.getByRole("link", { name: "Open profile" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    const personId = new URL(page.url()).pathname.split("/").pop()!;
    const db = new PrismaClient();
    try {
      const hash = await hashPassword(password);
      const fixture = await withTenant(db, bootstrapOrganizationId, async (tx) => {
        const administrator = await tx.userAccount.findFirstOrThrow({ where: { organizationId: bootstrapOrganizationId, email } });
        const account = await tx.userAccount.create({
          data: {
            organizationId: bootstrapOrganizationId,
            personId,
            email: staffEmail,
            passwordHash: hash,
            authCredentials: {
              create: {
                organizationId: bootstrapOrganizationId,
                type: "PASSWORD",
                label: "Test password",
                secretHash: hash
              }
            }
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: bootstrapOrganizationId,
            name: `${name} villa`,
            addressLine1: "Test address",
            city: "Marrakech",
            propertyType: "VILLA",
            bedrooms: 2,
            bathrooms: 2,
            maxGuests: 4,
            amenities: [],
            photoUrls: []
          }
        });
        const role = await tx.role.findFirstOrThrow({
          where: { organizationId: bootstrapOrganizationId, key: "field_staff" }
        });
        const gardener = await tx.role.findFirstOrThrow({
          where: { organizationId: bootstrapOrganizationId, key: "gardener" }
        });
        const wallet = await tx.ledgerAccount.create({
          data: {
            organizationId: bootstrapOrganizationId,
            code: `TEAM_${randomUUID().replaceAll("-", "").toUpperCase()}`,
            name: `${name} wallet`,
            accountType: "STAFF_WALLET",
            normalSide: "DEBIT"
          }
        });
        const offset = await tx.ledgerAccount.create({
          data: {
            organizationId: bootstrapOrganizationId,
            code: `OFFSET_${randomUUID().replaceAll("-", "").toUpperCase()}`,
            name: `${name} offset`,
            accountType: "ASSET",
            normalSide: "DEBIT"
          }
        });
        const task = await tx.operationTask.create({
          data: {
            organizationId: bootstrapOrganizationId,
            propertyId: property.id,
            assignedToPersonId: personId,
            assignedToUserAccountId: account.id,
            dueDate: new Date("2027-02-02"),
            type: "POOL",
            state: "PLANNED",
            titleTranslations: { en: "Pool care", fr: "Entretien piscine" },
            idempotencyKey: randomUUID()
          }
        });
        const document = await tx.teamDocument.create({
          data: {
            organizationId: bootstrapOrganizationId,
            personId,
            title: "Private staff agreement",
            kind: "CONTRACT",
            storageKey: `${bootstrapOrganizationId}/staff/${personId}/${randomUUID()}`,
            contentType: "application/pdf",
            size: 100,
            expiresOn: new Date("2027-02-28"),
            confirmedAt: new Date(),
            createdBy: administrator.id
          }
        });
        await new ConfigRuleRepository(tx, bootstrapOrganizationId).createVersion({
          key: "notification.routing.staff_document_expiring", scopeType: "organization", effectiveFrom: new Date(),
          value: { roles: [], people: [administrator.personId], assigned: false, channels: ["in_app"] },
          reason: "Route the staff expiry reminder to its authorized administrator"
        });
        return { account, property, role, gardener, wallet, offset, task, document };
      });
      await scheduleTeamDocumentReminders(bootstrapOrganizationId, { db, now: new Date("2027-02-21T12:00:00Z") });
      await page.reload();
      await page.getByTestId("notification-bell").click();
      const reminder = page.getByTestId("notification-item").filter({ hasText: "A staff document is expiring." });
      await expect(reminder).toHaveCount(1);
      await reminder.getByRole("button", { name: "Open record", exact: true }).click();
      await expect(page.getByTestId("notification-panel")).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/en/app/team/${personId}$`));
      await page.getByText("Add assignment", { exact: true }).click();
      const assignment = page.getByTestId("team-assignment-form");
      expect(
        await assignment
          .getByLabel("Role", { exact: true })
          .locator("option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
      ).toContain(fixture.role.id);
      await assignment.getByLabel("Role", { exact: true }).selectOption(fixture.role.id);
      await assignment.getByLabel("Scope", { exact: true }).selectOption("property");
      await assignment.getByLabel("Scope record").selectOption(fixture.property.id);
      await assignment.getByLabel("Assignment starts").fill("2027-01-01");
      await assignment.getByLabel("Restrict access").check();
      await assignment.getByLabel("Reason", { exact: true }).fill("Property pool care assignment");
      await assignment.getByRole("button", { name: "Save", exact: true }).click();
      await expect(assignment.getByRole("status")).toHaveText("Saved.");
      await expect(page.getByTestId("team-assignment")).toHaveCount(1);
      await assignment.getByLabel("Role", { exact: true }).selectOption(fixture.gardener.id);
      await assignment.getByLabel("Reason", { exact: true }).fill("Additional garden assignment");
      await assignment.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("team-assignment")).toHaveCount(2);
      const staffRole = page
        .getByTestId("team-assignment")
        .filter({ has: page.getByRole("heading", { name: "Field Staff", exact: true }) });
      await staffRole.getByText("Add compensation version", { exact: true }).click();
      const compensation = staffRole.getByTestId("team-compensation-form");
      await compensation.getByLabel("Amount or percentage").fill("500.25");
      await compensation.getByLabel("Effective from").fill("2027-01-01");
      await compensation.getByLabel("Reason", { exact: true }).fill("Original pool care agreement");
      await compensation.getByRole("button", { name: "Save", exact: true }).click();
      await expect(staffRole.getByText("Version 1", { exact: false })).toBeVisible();
      await compensation.getByLabel("Amount or percentage").fill("600.50");
      await compensation.getByLabel("Effective from").fill("2027-02-01");
      await compensation.getByLabel("Reason", { exact: true }).fill("Reviewed pool care agreement");
      await compensation.getByRole("button", { name: "Save", exact: true }).click();
      await expect(staffRole.getByText("Version 2", { exact: false })).toBeVisible();
      await expect(staffRole).toContainText("500.25");
      await expect(staffRole).toContainText("600.50");
      await page.getByText("Request availability or leave", { exact: true }).click();
      const leave = page.getByTestId("team-availability-form");
      await leave.getByLabel("Type", { exact: true }).selectOption("LEAVE");
      await leave.getByLabel("From", { exact: true }).fill("2027-03-01");
      await leave.getByLabel("Back on").fill("2027-03-03");
      await leave.getByLabel("Reason", { exact: true }).fill("Requested annual leave");
      await leave.getByRole("button", { name: "Save", exact: true }).click();
      const decision = page.getByTestId("team-decision-form");
      await expect(decision).toBeVisible();
      await decision.getByLabel("Reason", { exact: true }).fill("Approved annual leave");
      await decision.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator(".status-badge").filter({ hasText: /^Approved$/u })).toBeVisible();
      await page.getByLabel("From", { exact: true }).first().fill("2027-02-01");
      await page.getByLabel("Back on", { exact: true }).first().fill("2027-03-01");
      // The workload date form has stable ids independent of leave forms.
      await page.locator("#team-from").fill("2027-02-01");
      await page.locator("#team-until").fill("2027-03-01");
      await page.getByRole("button", { name: "Apply dates" }).click();
      await expect(page.getByText(`${name} villa`, { exact: true }).last()).toBeVisible();
      await page.getByText("Link ledger account", { exact: true }).click();
      const wallet = page.getByTestId("team-wallet-form");
      await wallet.getByLabel("Ledger account", { exact: true }).selectOption(fixture.wallet.id);
      await wallet.getByLabel("Reason", { exact: true }).fill("Dedicated staff wallet account");
      await wallet.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("No movements recorded.")).toBeVisible();
      const staffContext = await browser.newContext(info.project.use);
      try {
        const staffPage = await staffContext.newPage();
        await staffPage.goto("/en/login");
        await staffPage.getByTestId("login-email").fill(staffEmail);
        await staffPage.getByTestId("login-password").fill(password);
        await staffPage.getByTestId("login-submit").click();
        await expect(staffPage).toHaveURL(/\/en\/app$/u);
        await staffPage.goto(`/en/app/team/${personId}`);
        await expect(staffPage.getByRole("heading", { level: 1 })).toHaveText(name);
        const text = await staffPage.locator("body").innerText();
        expect(text).not.toContain("500.25");
        expect(text).not.toContain("600.50");
        expect(text).not.toContain("Private staff agreement");
        expect(
          (
            await staffPage.request.get(`/api/team/documents/${fixture.document.id}`, {
              maxRedirects: 0
            })
          ).status()
        ).toBe(404);
        await staffPage.goto("/en/app/team");
        await expect(staffPage.getByRole("link", { name, exact: true })).toBeVisible();
        await expect(
          staffPage.getByRole("link", { name: "ALVILLAS E2E Admin", exact: true })
        ).toHaveCount(0);
      } finally {
        await staffContext.close();
      }
      for (const locale of ["fr", "ar", "en"]) {
        await page.goto(`/${locale}/app/team/${personId}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        if (info.project.name === "field-mobile")
          await page.setViewportSize({ width: 360, height: 780 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      const offboard = page.getByTestId("team-offboard-form");
      await offboard.getByLabel("Reason", { exact: true }).fill("Confirmed staff departure request");
      await offboard.getByRole("button", { name: "Offboard person" }).click();
      await expect(offboard.getByRole("status")).toContainText("conflicts");
      await withTenant(db, bootstrapOrganizationId, (tx) =>
        tx.operationTask.update({ where: { id: fixture.task.id }, data: { state: "CANCELLED" } })
      );
      await offboard.getByRole("button", { name: "Offboard person" }).click();
      await expect(page.getByText("Offboarded", { exact: true })).toBeVisible();
      const persisted = await withTenant(db, bootstrapOrganizationId, (tx) =>
        tx.userAccount.findUniqueOrThrow({ where: { id: fixture.account.id } })
      );
      expect(persisted.status).toBe("DEACTIVATED");
      const anonymous = await browser.newContext();
      try {
        expect(
          (
            await anonymous.request.get(
              `/api/team/documents/${fixture.document.id}`,
              { maxRedirects: 0 }
            )
          ).status()
        ).toBe(401);
      } finally {
        await anonymous.close();
      }
    } finally {
      await db.$disconnect();
    }
  });
});
