import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import fr from "../messages/fr.json" with { type: "json" };
import ar from "../messages/ar.json" with { type: "json" };
import { setPropertyCity } from "../tests/e2e/support/property-form";

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = process.env.STAGING_EXPECTED_SHA;
const storageState = process.env.STAGING_STORAGE_STATE_FILE;
const evidenceFile = process.env.STAGING_EVIDENCE_FILE;
if (!sha || !/^[a-f0-9]{40}$/u.test(sha) || !storageState || !evidenceFile)
  throw new Error(
    "Verified staging SHA, private session and evidence path required",
  );
const messages = { en: en.Automation, fr: fr.Automation, ar: ar.Automation };
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: origin,
  storageState,
  viewport: { width: 1440, height: 1000 },
  timezoneId: "America/Denver",
});
context.setDefaultTimeout(30000);
const page = await context.newPage();
const hydrationErrors: string[] = [];
page.on("pageerror", (error) => {
  if (/hydrat|#418/iu.test(error.message)) hydrationErrors.push(error.message);
});
const resumePropertyId = process.env.STAGING_RESUME_PROPERTY_ID;
const resumeRun = process.env.STAGING_RESUME_RUN;
const resumeReservationId = process.env.STAGING_RESUME_RESERVATION_ID;
if (resumePropertyId || resumeRun || resumeReservationId) {
  z.uuid().parse(resumePropertyId);
  z.string().regex(/^aut-[a-f0-9]{8}$/u).parse(resumeRun);
  if (resumeReservationId) z.uuid().parse(resumeReservationId);
}
const run = resumeRun ?? `aut-${randomUUID().slice(0, 8)}`;
const propertyName = `Automation acceptance ${run}`;
const checks: Array<Record<string, unknown>> = [];
let step = "version";
try {
  expect(
    await (await context.request.get("/api/version")).json(),
  ).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  z.object({
    user: z.object({ id: z.uuid(), securitySetupRequired: z.literal(false) }),
  }).parse(await (await context.request.get("/api/auth/session")).json());
  step = "native-owner-property";
  if (!resumePropertyId) {
    await page.goto("/en/app/owners");
    await page.getByTestId("owner-display-name").fill(propertyName);
    await page.getByTestId("owner-email").fill(`${run}@example.test`);
    await page.getByTestId("owner-preferred-locale").selectOption("en");
    await page.getByTestId("owner-submit").click();
    await expect(
      page.getByRole("heading", { name: propertyName, exact: true }),
    ).toBeVisible();
    await page.goto("/en/app/properties");
    await page
      .getByTestId("property-owner")
      .selectOption({ label: propertyName });
    await page.getByTestId("property-name").fill(propertyName);
    await page.getByTestId("property-type").fill("Villa");
    await page
      .getByTestId("property-address")
      .fill("Automation staging acceptance");
    await setPropertyCity(page, "Marrakech");
    await page.getByTestId("property-bedrooms").fill("2");
    await page.getByTestId("property-bathrooms").fill("2");
    await page.getByTestId("property-max-guests").fill("4");
    await page.getByTestId("property-submit").click();
    await expect(
      page.getByRole("heading", { name: propertyName, exact: true }),
    ).toBeVisible();
  }
  await page.goto("/en/app/automations");
  const t = messages.en;
  const form = page.getByTestId("automation-create-form");
  const propertyId = await form
    .locator('[name="propertyId"] option')
    .filter({ hasText: propertyName })
    .getAttribute("value");
  if (!propertyId)
    throw new Error("Created property is missing from the authorized scope");
  if (resumePropertyId) expect(propertyId).toBe(resumePropertyId);
  step = "editable-standard-library";
  // A fresh staging navigation can expose server-rendered controls before the
  // client editor is ready. Observe its conditional UI before opening details.
  const waitForEditor = async () => {
    const scheduled = form.getByLabel(t.scheduled, { exact: true });
    await expect(async () => {
      await scheduled.uncheck();
      await scheduled.check();
      await expect(form.getByLabel(t.hour, { exact: true })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30000, intervals: [250, 500] });
    await scheduled.uncheck();
    await expect(form.getByLabel(t.hour, { exact: true })).toHaveCount(0);
  };
  await waitForEditor();
  const library = page
    .locator("details")
    .filter({
      has: page.locator("summary").filter({ hasText: t.library }),
    });
  await library.locator("summary").click();
  await library.locator('[name="propertyId"]').selectOption(propertyId);
  await library
    .locator('[name="reason"]')
    .fill("Install reviewed automation acceptance configuration");
  await library.getByRole("button", { name: t.install, exact: true }).click();
  await expect(library.getByRole("status")).toBeVisible();
  step = "create-rule";
  const rule = () =>
    page
      .getByTestId("automation-rule")
      .filter({ hasText: `automation.rule.${run}` });
  if ((await rule().count()) === 0) {
    await form.locator('[name="key"]').fill(run);
    await form.locator('[name="propertyId"]').selectOption(propertyId);
    await form.getByLabel(t.nameEn).fill(`Arrival inspection ${run}`);
    await form.getByLabel(t.nameFr).fill(`Inspection arrivee ${run}`);
    await form.getByLabel(t.conditions, { exact: true }).fill('{"all":[]}');
    await form.getByLabel(t.actions, { exact: true }).fill(
      JSON.stringify([
        {
          key: "arrival-inspection",
          type: "create_task",
          task_type: "INSPECTION",
          title: {
            en: `Automation inspection ${run}`,
            fr: `Inspection automatique ${run}`,
          },
          due: { from: "reservation.check_in", offset_days: -1 },
          priority: "HIGH",
          checklist_template: "automation-cleaning",
        },
      ]),
    );
    await form
      .locator('[name="reason"]')
      .fill("Authenticated staging inspection acceptance");
    await form.getByRole("button", { name: t.save, exact: true }).click();
    await expect(form.getByRole("status")).toBeVisible();
  }
  if (
    (await rule().getByRole("button", { name: t.pause, exact: true }).count()) === 0
  ) {
    await rule()
      .locator('form:has(input[value="state"]) input[name="reason"]')
      .fill("Activate reviewed staging inspection");
    const resume = rule().getByRole("button", { name: t.resume, exact: true });
    await (await resume.count() ? resume : rule().getByRole("button", { name: t.activate, exact: true })).click();
    await expect(
      rule().getByRole("button", { name: t.pause, exact: true }),
    ).toBeVisible();
  }
  step = "native-reservation-event-cloud-execution";
  await page.goto("/en/app/reservations");
  if (resumeReservationId) {
    const existing = page.getByTestId("reservation-row")
      .filter({ hasText: `Automation guest ${run}` })
      .filter({ hasText: propertyName });
    await expect(existing).toHaveCount(1);
    const href = `/en/app/reservations/${resumeReservationId}`;
    await expect(existing.locator("a").first()).toHaveAttribute("href", href);
    await page.goto(href);
    await expect(page.getByTestId("reservation-status")).toContainText(
      en.ReservationManagement.states.CONFIRMED,
    );
  } else {
    await page.getByTestId("reservation-property").selectOption(propertyId);
    await page
      .getByTestId("reservation-guest-name")
      .fill(`Automation guest ${run}`);
    await page
      .getByTestId("reservation-guest-email")
      .fill(`guest-${run}@example.test`);
    await page.getByTestId("reservation-check-in").fill("2027-04-10");
    await page.getByTestId("reservation-check-out").fill("2027-04-17");
    await page.getByTestId("reservation-adults").fill("2");
    await page.getByTestId("reservation-children").fill("0");
    await page.getByTestId("reservation-submit").click();
    // The server transaction retains its own 30-second bound. This includes the
    // action queue and destination render as well as that transaction.
    await expect(page).toHaveURL(/\/en\/app\/operations/u, { timeout: 90000 });
  }
  // Admission and execution must come from the deployed Inngest consumers and cron.
  // This script never calls a worker, writes database rows or sends synthetic events.
  await expect(async () => {
    await page.goto(`/en/app/automations?propertyId=${propertyId}`);
    await expect(
      page
        .getByTestId("automation-run")
        .filter({ hasText: `automation.rule.${run}` }),
    ).toContainText(t.statuses.SUCCEEDED, { timeout: 1000 });
  }).toPass({ timeout: 240000, intervals: [5000, 10000] });
  const execution = page
    .getByTestId("automation-run")
    .filter({ hasText: `automation.rule.${run}` });
  await expect(execution).toHaveCount(1);
  const details = await execution.locator("pre").textContent();
  const executionData = z
    .object({
      inputs: z.object({
        fields: z.object({ event: z.object({ id: z.uuid() }) }),
      }),
      attempts: z.array(z.unknown()),
    })
    .parse(JSON.parse(details ?? "null"));
  expect(executionData.attempts).toHaveLength(1);
  const sourceId = executionData.inputs.fields.event.id;
  step = "dry-run-pause-resume";
  await waitForEditor();
  if (typeof sourceId === "string")
    await rule().locator('[name="eventId"]').selectOption(sourceId);
  await rule().getByRole("button", { name: t.preview, exact: true }).click();
  await expect(rule().getByTestId("automation-preview")).toContainText(
    t.matched,
    { timeout: 60000 },
  );
  for (const [button, next] of [
    [t.pause, t.resume],
    [t.resume, t.pause],
    [t.pause, t.resume],
  ]) {
    await rule()
      .locator('form:has(input[value="state"]) input[name="reason"]')
      .fill("Staging acceptance lifecycle verification");
    await rule().getByRole("button", { name: button, exact: true }).click();
    await expect(
      rule().getByRole("button", { name: next, exact: true }),
    ).toBeVisible();
  }
  await page.goto(`/en/app/operations?propertyId=${propertyId}`);
  const tasks = page
    .getByTestId("operation-task-row")
    .filter({ hasText: propertyName });
  await expect(
    tasks.filter({ hasText: `Automation inspection ${run}` }),
  ).toHaveCount(1);
  checks.push({
    flow: "native-reservation-outbox-cloud-task-and-single-attempt",
    passed: true,
    propertyId,
    ruleKey: `automation.rule.${run}`,
  });
  step = "languages-mobile-keyboard-accessibility";
  for (const locale of ["en", "fr", "ar"] as const)
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${locale}/app/automations`);
      await expect(
        page.getByRole("heading", {
          name: messages[locale].title,
          exact: true,
        }),
      ).toBeVisible();
      expect(await page.locator("html").getAttribute("dir")).toBe(
        locale === "ar" ? "rtl" : "ltr",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
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
      checks.push({
        locale,
        width,
        keyboard: true,
        axe: true,
        overflow: false,
      });
    }
  expect(hydrationErrors).toEqual([]);
  await writeFile(
    evidenceFile,
    JSON.stringify({ sha, origin, run, checks }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      stagingAutomation: "passed",
      sha,
      checks: checks.length,
      productionChanges: 0,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      stagingAutomation: "failed",
      step,
      error: error instanceof Error ? error.message.split("\n")[0] : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
