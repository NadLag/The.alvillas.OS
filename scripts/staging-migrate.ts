import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertStagingTarget } from "./staging-target";

export function stagingDatabaseIdentity(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid staging database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error("Invalid staging database URL");
  }
  return createHash("sha256").update(`${url.hostname.replace("-pooler", "")}${url.pathname}`).digest("hex");
}

export function assertStagingMigrationTarget(env: NodeJS.ProcessEnv): string {
  assertStagingTarget(env);
  const databaseUrl = env.STAGING_MIGRATION_DATABASE_URL;
  const identity = env.STAGING_DATABASE_IDENTITY;
  if (!databaseUrl || !identity || !/^[a-f0-9]{64}$/u.test(identity) || stagingDatabaseIdentity(databaseUrl) !== identity) {
    throw new Error("Staging migration credential does not match the approved preview database");
  }
  return databaseUrl;
}

function main(): void {
  const databaseUrl = assertStagingMigrationTarget(process.env);
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8"
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .replaceAll(databaseUrl, "[staging database]").replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, "[staging database]");
  process.stdout.write(output);
  if (result.error) throw new Error("Could not start staging migration command");
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
