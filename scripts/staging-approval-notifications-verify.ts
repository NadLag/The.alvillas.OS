import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const expect = playwrightExpect.configure({ timeout: 30000 });
process.loadEnvFile(".env.local");
const origin = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const stateFile = process.env.STAGING_STORAGE_STATE_FILE;
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!expectedSha || !stateFile || !oidc) throw new Error("Existing staging authentication, version and development OIDC are required");
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: stateFile, viewport: { width: 1440, height: 1000 } });
await context.route("**/*", async (route) => {
  const headers = route.request().headers();
  if (new URL(route.request().url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
  await route.continue({ headers });
});
const page = await context.newPage();
let step = "version";
let propertyId: string | undefined;
let originalRouting: { roles: string[]; people: string[]; assigned: boolean; channels: string[] } | undefined;
const originalPreferences: Record<string, boolean> = {};
const completed: string[] = [];
async function openRouting() {
  await page.goto("/en/app/notifications"); await expect(page.getByTestId("routing-in-app")).toBeVisible();
  await page.getByTestId("routing-event").selectOption("approval_requested"); await expect(page.getByTestId("routing-in-app")).toBeVisible();
  if (propertyId) { await page.getByTestId("routing-scope").selectOption(propertyId); await expect(page.getByTestId("routing-in-app")).toBeVisible(); }
}
async function selected(prefix: string) {
  return page.locator(`input[data-testid^="${prefix}"]`).evaluateAll((nodes) => nodes.filter((node) => (node as HTMLInputElement).checked).map((node) => node.getAttribute("data-testid")!.slice(prefix.length)));
}
async function saveRouting(reason: string) {
  await page.getByTestId("routing-reason").fill(reason); await page.getByTestId("routing-save").click();
  await expect(page.getByTestId("routing-status")).toContainText("Routing saved"); await expect(page.getByTestId("routing-reason")).toHaveValue("");
}
try {
  const version: unknown = await (await page.goto("/api/version"))?.json();
  expect(version).toMatchObject({ version: expectedSha, environment: "preview", commitRef: "main" });
  step = "existing-authentication";
  const session = await (await page.goto("/api/auth/session"))?.json() as { user?: { id?: string; personId?: string; securitySetupRequired?: boolean } };
  if (!session?.user?.id || !session.user.personId || session.user.securitySetupRequired) throw new Error("Existing enrolled owner sign-in is required; credentials will not be reset");
  await openRouting();
  const firstProperty = await page.getByTestId("routing-scope").locator("option").evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).find(Boolean));
  if (!firstProperty) throw new Error("An existing scoped staging property is required");
  propertyId = firstProperty; await openRouting();
  originalRouting = { roles: await selected("routing-role-"), people: await selected("routing-person-"), assigned: false, channels: [] };
  for (const channel of ["in_app", "email", "push"]) if (await page.getByTestId(channel === "in_app" ? "routing-in-app" : `routing-${channel}`).isChecked()) originalRouting.channels.push(channel);
  for (const id of ["notification-in-app-enabled", "notification-operations"]) { originalPreferences[id] = await page.getByTestId(id).isChecked(); await page.getByTestId(id).check(); }
  if (await page.getByTestId("notification-preferences-save").isEnabled()) { await page.getByTestId("notification-preferences-save").click(); await expect(page.locator(".notification-settings").getByRole("status")).toContainText("Your preferences have been saved."); }
  for (const id of originalRouting.roles) await page.getByTestId(`routing-role-${id}`).uncheck();
  for (const id of originalRouting.people) await page.getByTestId(`routing-person-${id}`).uncheck();
  await page.getByTestId(`routing-person-${session.user.personId}`).check(); await page.getByTestId("routing-in-app").check();
  for (const channel of ["email", "push"]) await page.getByTestId(`routing-${channel}`).uncheck();
  await saveRouting("Staging acceptance: route operational review to the signed-in reviewer");
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const decision of ["APPROVED", "REJECTED"]) {
      step = `request-${width}-${decision}`;
      await page.goto(`/en/app/properties/${propertyId}/approvals/new`);
      await page.getByTestId("approval-title").fill(`Notification workflow acceptance ${width} ${decision}`);
      await page.getByTestId("approval-details").fill("Review the staging operational notification workflow and record the acceptance decision. This request does not authorize spending or change financial records.");
      await page.getByTestId("approval-request").click(); await expect(page).toHaveURL(/\/en\/app\/approvals\/[a-f0-9-]+$/u);
      const id = page.url().split("/").at(-1)!;
      await page.getByTestId("notification-bell").click();
      const notice = page.getByTestId("notification-item").filter({ hasText: "An approval needs your decision." }).filter({ has: page.getByText("Unread", { exact: true }) });
      await expect(notice).toHaveCount(1); await notice.getByRole("button", { name: "Open record", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/en/app/approvals/${id}$`, "u"));
      for (const locale of ["en", "fr", "ar"]) {
        await page.goto(`/${locale}/app/approvals/${id}`); await expect(page.getByTestId("approval-reason")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      await page.goto(`/en/app/approvals/${id}`); await page.getByTestId("approval-reason").fill(`Staging workflow reviewed: ${decision.toLowerCase()} with an auditable reason`);
      await page.getByTestId(decision === "APPROVED" ? "approval-approve" : "approval-reject").click();
      await expect(page.getByTestId("approval-state")).toHaveText(decision === "APPROVED" ? "Approved" : "Rejected");
      await page.reload(); await expect(page.getByTestId("approval-approve")).toHaveCount(0);
      await page.getByTestId("notification-bell").click();
      await expect(page.getByTestId("notification-resolution").filter({ hasText: decision === "APPROVED" ? "Approved" : "Rejected" })).toHaveCount(width === 1440 ? 1 : 2);
      await page.keyboard.press("Escape"); completed.push(`${width}:${decision}`);
    }
  }
  console.log(JSON.stringify({ authenticated: true, approvalJourneys: completed, locales: ["en", "fr", "ar"], axeViolations: 0, credentialMutations: 0, financialMutations: 0, externalDeliveryClaimed: false }));
} catch { console.error(JSON.stringify({ step, status: "failed", completed })); process.exitCode = 1; }
finally {
  if (originalRouting && propertyId) {
    try {
      await openRouting();
      for (const prefix of ["routing-role-", "routing-person-"]) {
        for (const id of await selected(prefix)) await page.getByTestId(prefix + id).uncheck();
        for (const id of prefix === "routing-role-" ? originalRouting.roles : originalRouting.people) await page.getByTestId(prefix + id).check();
      }
      for (const channel of ["in_app", "email", "push"]) await page.getByTestId(channel === "in_app" ? "routing-in-app" : `routing-${channel}`).setChecked(originalRouting.channels.includes(channel));
      await saveRouting("Restore the original approval routing after staging acceptance");
      await page.getByTestId("notification-in-app-enabled").check(); await page.getByTestId("notification-operations").setChecked(originalPreferences["notification-operations"]);
      await page.getByTestId("notification-in-app-enabled").setChecked(originalPreferences["notification-in-app-enabled"]);
      if (await page.getByTestId("notification-preferences-save").isEnabled()) { await page.getByTestId("notification-preferences-save").click(); await expect(page.locator(".notification-settings").getByRole("status")).toContainText("Your preferences have been saved."); }
      console.log(JSON.stringify({ originalRoutingAndPreferencesRestored: true }));
    } catch { console.error(JSON.stringify({ step: "restore-routing-and-preferences", status: "failed" })); process.exitCode = 1; }
  }
  await context.close(); await browser.close();
}
