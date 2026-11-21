import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget } from "./staging-target";
import { captureStagingHistory, compareStagingHistory } from "./staging-history-repository";

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

function applyMigrations(databaseUrl: string): boolean {
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8"
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .replaceAll(databaseUrl, "[staging database]").replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, "[staging database]");
  process.stdout.write(output);
  if (result.error) throw new Error("Could not start staging migration command");
  return result.status === 0;
}

async function main(): Promise<void> {
  const databaseUrl = assertStagingMigrationTarget(process.env);
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const original = await captureStagingHistory(client);
    if (!applyMigrations(databaseUrl)) {
      process.exitCode = 1;
      return;
    }
    const current = await captureStagingHistory(client, original.columns);
    const preservation = compareStagingHistory(original.rows, current.rows);
    console.log(JSON.stringify({ stagingHistory: preservation }));
    if (preservation.some(table => table.changed > 0)) {
      console.error("Original staging history changed during migration");
      process.exitCode = 1;
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("Staging migration or history verification could not complete");
    process.exitCode = 1;
  });
}
