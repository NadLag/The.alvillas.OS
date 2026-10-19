import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = process.env.STAGING_EXPECTED_SHA,
  state = process.env.STAGING_STORAGE_STATE_FILE;
const fixtureFile = process.env.STAGING_OPERATIONS_FIXTURE_FILE,
  evidenceFile = process.env.STAGING_EVIDENCE_FILE;
if (!sha || !state || !fixtureFile || !evidenceFile)
  throw new Error(
    "Staging SHA, private session, fixture and evidence paths are required",
  );
const fixture = z
  .object({
    propertyId: z.uuid(),
    proxyTaskId: z.uuid(),
    workerPersonId: z.uuid(),
    actorPersonId: z.uuid(),
    actorId: z.uuid(),
    organizationId: z.uuid(),
    run: z.string().regex(/^[a-z0-9-]{1,50}$/u),
  })
  .parse(JSON.parse(await readFile(fixtureFile, "utf8")));
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: origin,
  storageState: state,
  viewport: { width: 1440, height: 1000 },
});
context.setDefaultTimeout(30000);
try {
  expect(
    await (await context.request.get("/api/version")).json(),
  ).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  expect(
    await (await context.request.get("/api/auth/session")).json(),
  ).toMatchObject({
    user: {
      id: fixture.actorId,
      organizationId: fixture.organizationId,
      securitySetupRequired: false,
    },
  });
  const page = await context.newPage(),
    checks: Array<Record<string, unknown>> = [];
  const day = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(
      new Date(Date.now() + offset * 86400000),
    );
  const today = day(0),
    tomorrow = day(1),
    fieldDay = day(7);
  await page.goto(`/en/app/operations/new?propertyId=${fixture.propertyId}`);
  const create = page.getByTestId("operation-create-form");
  await create.locator('[name="type"]').selectOption("LAUNDRY");
  await create.locator('[name="titleEn"]').fill(`Field laundry ${fixture.run}`);
  await create
    .locator('[name="titleFr"]')
    .fill(`Blanchisserie terrain ${fixture.run}`);
  await create.locator('[name="dueDate"]').fill(fieldDay);
  await create
    .locator('[name="reason"]')
    .fill("Authenticated staging field checklist acceptance");
  await create.locator('button[type="submit"]').click();
  await expect(page.getByTestId("operation-detail-page")).toBeVisible();
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  const reschedule = page.getByTestId("operation-reschedule-form");
  await reschedule.locator('[name="startTime"]').fill("02:00");
  await reschedule
    .locator('[name="reason"]')
    .fill("Reserve an isolated field acceptance window");
  await reschedule.locator('button[type="submit"]').click();
  await expect(reschedule.getByRole("status")).toBeVisible();
  const assign = page.getByTestId("operation-assign-form");
  await assign.locator('[name="personId"]').selectOption(fixture.actorPersonId);
  await assign
    .locator('[name="reason"]')
    .fill("Assign the signed-in operator for field acceptance");
  await assign.locator('button[type="submit"]').click();
  await expect(assign.getByRole("status")).toBeVisible();

  await page.goto(`/en/app/field/${taskId}`);
  const field = page.getByTestId("field-task-complete-form");
  await expect(page.getByTestId("field-task-complete")).toBeDisabled();
  for (const item of await field.locator('[name="checklistItemIds"]').all())
    await item.check();
  await field.locator('[data-progress="true"]').click();
  await expect(field.getByRole("status")).toBeVisible();
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
    "base64",
  );
  const photo = page.getByTestId("operation-evidence-form");
  await photo
    .locator('[name="file"]')
    .setInputFiles({
      name: "readiness.png",
      mimeType: "image/png",
      buffer: imageBytes,
    });
  await photo
    .locator('[name="reason"]')
    .fill(`Authenticated private photo ${fixture.run}`);
  await photo.locator('button[type="submit"]').click();
  const panel = page.getByTestId("task-evidence-panel");
  await expect(
    panel.getByText(`Authenticated private photo ${fixture.run}`, {
      exact: true,
    }),
  ).toBeVisible();
  const photoPath = await panel
    .locator('a[href^="/api/operations/evidence/"]')
    .first()
    .getAttribute("href");
  const download = await context.request.get(photoPath!);
  expect(download.status()).toBe(200);
  expect(download.headers()["cache-control"]).toContain("no-store");
  expect(
    createHash("sha256")
      .update(await download.body())
      .digest("hex"),
  ).toBe(createHash("sha256").update(imageBytes).digest("hex"));
  const issue = page.getByTestId("operation-issue-form");
  await issue.locator('[name="title"]').fill(`Inspection issue ${fixture.run}`);
  await issue
    .locator('[name="reason"]')
    .fill("An inspection issue recorded during authenticated field acceptance");
  await issue.locator('button[type="submit"]').click();
  await expect(
    panel.getByText(`Inspection issue ${fixture.run}`, { exact: true }),
  ).toBeVisible();
  await page.getByTestId("field-task-complete").click();
  await expect(page).toHaveURL(/\/en\/app\/field$/u);
  await page.goto(`/en/app/operations/${taskId}`);
  await expect(page.getByTestId("task-performed-by")).toHaveAttribute(
    "data-person-id",
    fixture.actorPersonId,
  );
  checks.push({
    flow: "assigned-progress-private-photo-issue-self-completion",
    passed: true,
  });

  await page.goto(`/en/app/operations/${fixture.proxyTaskId}`);
  const proxy = page.getByTestId("operation-proxy-form");
  for (const item of await proxy.locator('[name="checklistItemIds"]').all())
    await item.check();
  await proxy
    .locator('[name="reason"]')
    .fill(
      "Worker could not connect during authenticated supervisor acceptance",
    );
  await proxy.locator('button[type="submit"]').click();
  await expect(page.getByTestId("task-performed-by")).toHaveAttribute(
    "data-person-id",
    fixture.workerPersonId,
  );
  await expect(page.getByTestId("task-validated-by")).toHaveAttribute(
    "data-person-id",
    fixture.actorPersonId,
  );
  checks.push({
    flow: "distinct-performer-proxy-validator-history",
    passed: true,
  });

  await page.goto(
    `/en/app/operations/recurring?propertyId=${fixture.propertyId}`,
  );
  const series = page.getByTestId("operation-series-form"),
    seriesTitle = `Daily pool ${fixture.run}`;
  await series.locator('[name="type"]').selectOption("POOL");
  await series.locator('[name="titleEn"]').fill(seriesTitle);
  await series
    .locator('[name="titleFr"]')
    .fill(`Piscine quotidienne ${fixture.run}`);
  await series.locator('[name="startsOn"]').fill(today);
  await series.locator('[name="endsOn"]').fill(today);
  await series.locator('[name="everyDays"]').fill("1");
  for (const box of await series.locator('[name="weekdays"]').all())
    await box.check();
  await series.locator('[name="startTime"]').fill("16:00");
  await series
    .locator('[name="reason"]')
    .fill("Configure a bounded staging recurrence");
  await series.locator('button[type="submit"]').click();
  await expect(
    page.getByRole("link", { name: seriesTitle, exact: true }),
  ).toBeVisible();
  const seriesEditPath = await page
    .getByRole("link", { name: seriesTitle, exact: true })
    .getAttribute("href");
  const listUrl = (date: string) =>
    `/en/app/operations?propertyId=${fixture.propertyId}&type=POOL&date=${date}&view=LIST`;
  await page.goto(listUrl(today));
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
  await generate.locator('button[type="submit"]').click();
  await expect(page.getByTestId("operation-task-row")).toHaveCount(1);
  const bulk = page.getByTestId("operation-bulk-form");
  for (const action of ["PRIORITY", "ASSIGN", "RESCHEDULE", "CANCEL"]) {
    if (action === "CANCEL") await page.goto(listUrl(tomorrow));
    await bulk.locator('[name="items"]').check();
    await bulk.locator('[name="bulkAction"]').selectOption(action);
    await bulk.locator('[name="priority"]').selectOption("URGENT");
    await bulk.locator('[name="startTime"]').fill("18:00");
    if (action === "RESCHEDULE")
      await bulk.locator('[name="dueDate"]').fill(tomorrow);
    await bulk
      .locator('[name="reason"]')
      .fill(`Authenticated bulk ${action.toLowerCase()} acceptance`);
    await bulk.locator('button[type="submit"]').click();
    if (action !== "RESCHEDULE")
      await expect(bulk.getByRole("status")).toBeVisible();
    else await expect(page.getByTestId("operation-task-row")).toHaveCount(0);
  }
  checks.push({
    flow: "recurrence-idempotency-bulk-priority-assign-reschedule-cancel",
    passed: true,
  });
  await page
    .locator("details")
    .filter({ has: page.getByTestId("operation-save_view-form") })
    .locator("summary")
    .click();
  const saved = page.getByTestId("operation-save_view-form"),
    savedName = `Operations acceptance ${fixture.run}`;
  await saved.locator('[name="name"]').fill(savedName);
  await saved.locator('button[type="submit"]').click();
  await expect(
    page.getByRole("link", { name: savedName, exact: true }),
  ).toBeVisible();

  for (const locale of ["en", "fr", "ar"])
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ["LIST", "TIMELINE", "DAY", "WEEK", "MONTH"]) {
        await page.goto(
          `/${locale}/app/operations?propertyId=${fixture.propertyId}&date=${tomorrow}&view=${view}`,
        );
        await expect(page.getByTestId("operation-task-count")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute(
          "dir",
          locale === "ar" ? "rtl" : "ltr",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        checks.push({ locale, width, view, axe: "passed", overflow: false });
      }
    }
  await page.goto(`/en/app/operations/recurring${seriesEditPath}`);
  const pause = page.getByTestId("operation-series-form");
  await pause.locator('[name="enabled"]').uncheck();
  await pause.locator('[name="cancelFuture"]').check();
  await pause
    .locator('[name="reason"]')
    .fill("Pause the completed staging acceptance recurrence");
  await pause.locator('button[type="submit"]').click();
  await expect(page.getByRole('listitem').filter({has:page.getByRole('link',{name:seriesTitle,exact:true})})).toContainText('Schedule paused');
  checks.push({ flow: "recurrence-edit-pause", passed: true });
  await writeFile(
    evidenceFile,
    JSON.stringify(
      {
        sha,
        origin,
        taskId,
        proxyTaskId: fixture.proxyTaskId,
        photoPath,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      sha,
      authenticated: true,
      checks: checks.length,
      privatePhoto: "verified",
      productionChanges: 0,
    }),
  );
} finally {
  await browser.close();
}
