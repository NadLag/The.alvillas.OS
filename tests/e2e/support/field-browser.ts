import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium, devices, type TestInfo } from "@playwright/test";

export async function fieldBrowser(info: TestInfo) {
  const profile = await mkdtemp(join(tmpdir(), "alvillas-field-pwa-"));
  const emulation = devices[info.project.name === "field-mobile" ? "Pixel 5" : "Desktop Chrome"];
  const context = await chromium.launchPersistentContext(profile, { baseURL: "http://127.0.0.1:3000", headless: true, channel: "chromium",
    userAgent: emulation.userAgent, isMobile: emulation.isMobile, hasTouch: emulation.hasTouch, deviceScaleFactor: emulation.deviceScaleFactor,
    ignoreDefaultArgs: ["--disable-background-networking"], viewport: info.project.name === "field-mobile" ? { width: 360, height: 800 } : { width: 1440, height: 1000 } });
  return { context, page: await context.newPage(), close: async () => {
    await context.close();
    const absolute = await realpath(profile), parent = await realpath(tmpdir());
    if (dirname(absolute) !== parent || !basename(absolute).startsWith("alvillas-field-pwa-")) throw new Error("Unexpected temporary browser profile path");
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } };
}
