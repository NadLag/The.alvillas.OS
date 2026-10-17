import { expect as playwrightExpect, type Page } from "@playwright/test";
const expect = playwrightExpect.configure({ timeout: 30000 });
export async function saveAndOpenTemplate(page: Page, key: string, name: string) {
  await page.getByTestId("template-key").fill(key);
  await page.getByTestId("template-name-en").fill(name);
  await page.getByTestId("template-name-fr").fill(`Modèle ${name}`);
  await page.getByTestId("template-reason").fill("Reviewed reusable property settings");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("template-message")).toHaveText("Saved.");
  await page.getByRole("link", { name: "Open saved template" }).click();
  await expect(page.getByTestId("template-save")).toHaveText("Save new version");
}
export async function applyTemplateVersion(page: Page, version = 1, revision = 1) {
  await expect(page.getByTestId("template-apply")).toHaveText(`Apply version ${version}`);
  await page.getByTestId("template-change-reason").fill("Apply reviewed reusable configuration");
  await page.getByTestId("template-apply").click();
  await expect(page.getByTestId("template-pinned")).toContainText(
    `version ${version} · property revision ${revision}`
  );
}
