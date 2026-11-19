import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

const catalogs = { en, fr, ar };

test("the public website offers localized navigation, assessment and sign-in at mobile width", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const [locale, { Website: t }] of Object.entries(catalogs)) {
    await page.goto(`/${locale}`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.hero.title);
    await expect(page.getByRole("heading", { name: t.pillars.ownerControl.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: t.coverage.title })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://alvillas.com/${locale}`);
    await expect(page.getByTestId("home-sign-in")).toHaveAttribute("href", `/${locale}/login`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const t = ar.Website;
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("navigation", { name: t.navigation }).getByRole("link", { name: t.management }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.pages.management.title);
  await page.getByRole("main").getByRole("link", { name: t.assessment }).click();
  await expect(page).toHaveURL(/\/ar\/assessment$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t.assessment);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain("https://alvillas.com/ar/assessment");
  const card = await request.get("/website-card");
  expect(card.ok()).toBe(true);
  expect(card.headers()["content-type"]).toContain("image/png");
});
