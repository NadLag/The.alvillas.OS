import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { saveAndOpenTemplate, applyTemplateVersion } from "../tests/e2e/support/template-forms";

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = process.env.STAGING_EXPECTED_SHA,
  storageState = process.env.STAGING_STORAGE_STATE_FILE;
const fixtureFile = process.env.STAGING_TEMPLATE_FIXTURE_FILE,
  evidenceFile = process.env.STAGING_TEMPLATE_EVIDENCE_FILE;
if (!sha || !storageState || !fixtureFile || !evidenceFile)
  throw new Error("Staging SHA, authenticated state, template fixture and evidence paths are required");
const fixture = z
  .object({
    organizationId: z.uuid(),
    actorId: z.uuid(),
    targetPropertyId: z.uuid(),
    catalogPropertyId: z.uuid(),
    bedrooms: z.number().int().nonnegative(),
    bathrooms: z.number().int().nonnegative(),
    run: z.string().regex(/^[a-z0-9-]{1,50}$/u)
  })
  .parse(JSON.parse(await readFile(fixtureFile, "utf8")) as unknown);
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: origin,
  storageState,
  viewport: { width: 1440, height: 1000 }
});
const page = await context.newPage();
let step = "version",
  restored = false;
let targetUrl: string | undefined;
const templateIds: Record<string, string> = {};
try {
  expect((await (await context.request.get("/api/version")).json()) as unknown).toMatchObject({
    version: sha,
    commitRef: "main",
    environment: "preview"
  });
  step = "authenticated-administrator";
  expect((await (await context.request.get("/api/auth/session")).json()) as unknown).toMatchObject({
    user: { id: fixture.actorId, organizationId: fixture.organizationId, securitySetupRequired: false }
  });
  step = "property-template-create";
  await page.goto(`/en/app/templates?property=${fixture.targetPropertyId}`);
  const editor = page.getByTestId("template-editor");
  for (const [label, value] of [
    ["Bedrooms", fixture.bedrooms],
    ["Bathrooms", fixture.bathrooms]
  ] as const) {
    await editor.getByRole("checkbox", { name: label, exact: true }).check();
    await editor.getByRole("spinbutton", { name: label, exact: true }).fill(String(value));
  }
  await saveAndOpenTemplate(page, `villa-standard-${fixture.run}`, `Villa 405 standard ${fixture.run}`);
  targetUrl = page.url();
  templateIds.PROPERTY = new URL(targetUrl).searchParams.get("template")!;
  await applyTemplateVersion(page);
  const bedroom = page.locator('[data-path="/property/bedrooms"]');
  step = "property-override";
  await bedroom.getByRole("spinbutton").fill(String(fixture.bedrooms + 1));
  await page.getByTestId("template-change-reason").fill("Verify a property-specific override");
  await page.getByTestId("template-override").click();
  await expect(page.getByTestId("template-pinned")).toContainText("property revision 2");
  step = "property-version-upgrade";
  await editor
    .getByRole("spinbutton", { name: "Bedrooms", exact: true })
    .fill(String(fixture.bedrooms + 2));
  await page.getByTestId("template-reason").fill("Verify explicit template version changes");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("template-update-available")).toContainText("Version 2");
  await page
    .getByTestId("template-card")
    .filter({ hasText: `Villa 405 standard ${fixture.run}` })
    .click();
  await expect(page.getByTestId("template-version-diff")).toBeVisible();
  await applyTemplateVersion(page, 2, 3);
  await expect(bedroom.getByRole("spinbutton")).toHaveValue(String(fixture.bedrooms + 1));
  step = "selected-reset";
  await bedroom.getByRole("checkbox").check();
  await page.getByTestId("template-change-reason").fill("Restore only the selected inherited bedrooms");
  await page.getByTestId("template-reset").click();
  await expect(page.getByTestId("template-pinned")).toContainText("property revision 4");
  await expect(bedroom.getByRole("spinbutton")).toHaveValue(String(fixture.bedrooms + 2));
  await expect(page.locator('[data-path="/property/bathrooms"]').getByRole("spinbutton")).toHaveValue(
    String(fixture.bathrooms)
  );
  step = "restore-original-property-values";
  await editor.getByRole("spinbutton", { name: "Bedrooms", exact: true }).fill(String(fixture.bedrooms));
  await page
    .getByTestId("template-reason")
    .fill("Preserve the original Villa 405 settings after verification");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("template-update-available")).toContainText("Version 3");
  await page
    .getByTestId("template-card")
    .filter({ hasText: `Villa 405 standard ${fixture.run}` })
    .click();
  await applyTemplateVersion(page, 3, 5);
  await expect(bedroom.getByRole("spinbutton")).toHaveValue(String(fixture.bedrooms));
  restored = true;
  targetUrl = page.url();
  await expect(page.getByTestId("template-history-row")).toHaveCount(5);
  for (const kind of ["CHECKLIST", "WORKFLOW", "INVENTORY", "SERVICE_CATALOG"]) {
    step = `${kind.toLowerCase()}-template`;
    await page.goto(`/en/app/templates?property=${fixture.catalogPropertyId}&kind=${kind}`);
    await page.getByTestId("template-scope").selectOption(fixture.catalogPropertyId);
    await page.getByTestId("template-add-entry").click();
    const entry = page.getByTestId("template-entry");
    await entry
      .getByRole("textbox", { name: "Reference", exact: true })
      .fill(kind === "CHECKLIST" ? `turnover-${fixture.run}` : `entry-${fixture.run}`);
    await entry
      .getByRole("textbox", { name: "Name · English", exact: true })
      .fill(`Template verification ${kind}`);
    await entry
      .getByRole("textbox", { name: "Name · French", exact: true })
      .fill(`Vérification de modèle ${kind}`);
    if (kind === "CHECKLIST") {
      await entry.getByRole("button", { name: "Add instruction" }).click();
      const item = entry.locator("fieldset");
      await item.getByRole("textbox", { name: "Reference", exact: true }).fill("linen");
      await item
        .getByRole("textbox", { name: "Instruction · English", exact: true })
        .fill("Inspect linen");
      await item
        .getByRole("textbox", { name: "Instruction · French", exact: true })
        .fill("Inspecter le linge");
    }
    if (kind === "WORKFLOW")
      await entry
        .getByRole("textbox", { name: "Reusable checklist reference (optional)", exact: true })
        .fill(`turnover-${fixture.run}`);
    if (kind === "INVENTORY") {
      await entry.getByRole("spinbutton", { name: "Minimum quantity", exact: true }).fill("8");
      await entry.getByRole("textbox", { name: "Unit", exact: true }).fill("piece");
    }
    if (kind === "SERVICE_CATALOG") {
      await entry.getByRole("textbox", { name: "Amount", exact: true }).fill("800.00");
      await entry.getByRole("textbox", { name: "Currency (ISO code)", exact: true }).fill("MAD");
    }
    await saveAndOpenTemplate(
      page,
      `${kind.toLowerCase()}-${fixture.run}`,
      `Template verification ${kind} ${fixture.run}`
    );
    templateIds[kind] = new URL(page.url()).searchParams.get("template")!;
    await applyTemplateVersion(page);
    expect(await page.getByTestId("template-diff-row").count()).toBeGreaterThan(0);
  }
  for (const width of [1440, 360])
    for (const locale of ["en", "fr", "ar"]) {
      step = `localized-${locale}-${width}`;
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${locale}/app/templates${new URL(targetUrl).search}`);
      await expect(page.getByTestId("template-editor")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  step = "anonymous-denial";
  const anonymous = await browser.newContext({ baseURL: origin });
  try {
    const p = await anonymous.newPage();
    await p.goto("/en/app/templates");
    await expect(p).toHaveURL(/\/en\/login$/u);
    await expect(p.getByTestId("template-editor")).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
  const evidence = {
    sha,
    authenticated: true,
    propertyValuesRestored: restored,
    templateIds,
    categoriesApplied: 5,
    versionUpgradePreservedOverride: true,
    selectedReset: true,
    immutableHistoryVisible: true,
    widths: [1440, 360],
    locales: ["en", "fr", "ar"],
    axeViolations: 0,
    anonymousDenied: true,
    credentialMutations: 0,
    productionChanges: 0
  };
  await writeFile(evidenceFile, JSON.stringify(evidence));
  console.log(JSON.stringify(evidence));
} catch {
  console.error(
    JSON.stringify({
      step,
      status: "failed",
      propertyValuesRestored: restored,
      templateIds,
      credentialMutations: 0,
      productionChanges: 0
    })
  );
  process.exitCode = 1;
} finally {
  if (!restored && targetUrl) {
    try {
      await page.goto(targetUrl);
      const field = page.locator('[data-path="/property/bedrooms"]');
      if (await field.count()) {
        const previous = await page.getByTestId("template-pinned").innerText();
        await field.getByRole("spinbutton").fill(String(fixture.bedrooms));
        await page
          .getByTestId("template-change-reason")
          .fill("Restore original property settings after interrupted verification");
        await page.getByTestId("template-override").click();
        await expect(page.getByTestId("template-pinned")).not.toHaveText(previous);
        await page.reload();
        await expect(field.getByRole("spinbutton")).toHaveValue(String(fixture.bedrooms));
      }
    } catch {
      console.error(
        JSON.stringify({ restorationRequiresAttention: true, propertyId: fixture.targetPropertyId })
      );
    }
  }
  await context.close();
  await browser.close();
}
