import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { prepareStagingFieldWorker } from "./support/staging-field-worker-baseline";

const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE), file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const profile = await realpath(z.string().min(1).parse(process.env.STAGING_PROFILE_DIRECTORY)), parent = await realpath(dirname(state));
const fixture = z.object({ organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid() })
  .parse(JSON.parse(await readFile(z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE), "utf8")));
if (dirname(profile) !== parent || dirname(await realpath(file)) !== parent || basename(profile) !== "staging-field-proxy-offline-native" ||
  (await readdir(profile)).length || Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")))).length) throw new Error("A new private native worker profile is required");
const saved = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })) }).parse(JSON.parse(await readFile(state, "utf8")));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", baseURL: origin,
  ignoreDefaultArgs: ["--disable-background-networking"], viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
try {
  await context.addCookies(saved.cookies.filter(cookie => cookie.domain.replace(/^\./u, "") === new URL(origin).hostname));
  const prepared = await prepareStagingFieldWorker(context, context.pages()[0] ?? await context.newPage(), sha, fixture);
  await writeFile(file, JSON.stringify(prepared, null, 2));
  console.log(JSON.stringify({ sha, authenticatedNativeWorkerPrepared: true, nativeDatabaseVersion: prepared.nativeVersion, taskMutations: 0 }));
} catch { throw new Error("Native worker preparation incomplete; preserve the private profile for read-only recovery"); }
finally { await context.close(); }
