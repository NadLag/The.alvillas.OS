import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium, devices, type BrowserContext, type TestInfo } from "@playwright/test";

function fieldEmulation(info: TestInfo) {
  const preset = devices[info.project.name === "field-mobile" ? "Pixel 5" : "Desktop Chrome"];
  return { baseURL: "http://127.0.0.1:3000", userAgent: preset.userAgent, isMobile: preset.isMobile, hasTouch: preset.hasTouch,
    deviceScaleFactor: preset.deviceScaleFactor, viewport: info.project.name === "field-mobile" ? { width: 360, height: 800 } : { width: 1440, height: 1000 } };
}

export async function fieldEditorContext(context: BrowserContext, info: TestInfo) {
  const browser = context.browser(); if (!browser) throw new Error("Native field browser required");
  const editor = await browser.newContext({ ...fieldEmulation(info), storageState: await context.storageState() });
  editor.setDefaultTimeout(30000); editor.setDefaultNavigationTimeout(30000);
  return editor;
}

export async function fieldBrowser(info: TestInfo) {
  const profile = await mkdtemp(join(tmpdir(), "alvillas-field-pwa-"));
  const context = await chromium.launchPersistentContext(profile, { ...fieldEmulation(info), headless: true, channel: "chromium",
    ignoreDefaultArgs: ["--disable-background-networking"] });
  context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
  return { context, page: await context.newPage(), close: async () => {
    await context.close();
    const absolute = await realpath(profile), parent = await realpath(tmpdir());
    if (dirname(absolute) !== parent || !basename(absolute).startsWith("alvillas-field-pwa-")) throw new Error("Unexpected temporary browser profile path");
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } };
}
