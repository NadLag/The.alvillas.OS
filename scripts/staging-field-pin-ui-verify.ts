import { writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import fr from "../messages/fr.json" with { type: "json" };
import ar from "../messages/ar.json" with { type: "json" };

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const origin = "https://the-alvillas-os-staging.vercel.app", browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
const checks: Array<{ locale: string; width: number }> = [], errors: string[] = []; let authenticationPosts = 0;
context.setDefaultNavigationTimeout(90000);
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && /\/(en|fr|ar)\/login$/u.test(new URL(request.url()).pathname)) authenticationPosts++; });
  for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`/${locale}/login?surface=field`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.locator('input[name="method"][value="pin"]')).toBeChecked();
    const keypad = page.getByTestId("login-pin-keypad"), pin = page.getByTestId("login-pin");
    await expect(keypad).toHaveAccessibleName({ en, fr, ar }[locale].Login.pinKeypad); await expect(pin).toHaveAttribute("type", "password");
    for (const button of await keypad.getByRole("button").all()) { await expect(button).toHaveAttribute("type", "button"); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(64); }
    await page.getByTestId("pin-key-1").focus(); await page.keyboard.press("Enter"); await page.getByTestId("pin-key-2").click(); await page.getByTestId("pin-key-0").click();
    await expect(pin).toHaveValue("120"); await page.getByTestId("pin-key-delete").focus(); await page.keyboard.press("Enter"); await expect(pin).toHaveValue("12");
    await page.getByTestId("pin-key-clear").click(); await expect(pin).toHaveValue("");
    await pin.fill("١٢٠"); await expect(pin).toHaveValue("120"); await page.getByTestId("pin-key-clear").click();
    await expect(page.getByTestId("login-phone")).toHaveValue("");
    await expect(page.getByTestId("locale-switch-fr")).toHaveAttribute("href", "/fr/login?surface=field");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    checks.push({ locale, width });
  }
  expect(authenticationPosts).toBe(0); expect(errors).toEqual([]);
  await writeFile(file, JSON.stringify({ sha, origin, completed: true, uiOnly: true, authenticationPosts, checks, keyboardAndAxe: true,
    authenticatedPinAcceptance: false, blocker: "A suitable existing real field account has not been identified; F-FLD-02 remains IN-PROGRESS." }, null, 2));
  console.log(JSON.stringify({ sha, fieldPinUiChecks: checks.length, authenticationPosts: 0, authenticatedPinAcceptance: false }));
} catch { throw new Error("Staging field PIN UI checks failed; no credentials were submitted"); }
finally { await browser.close(); }
