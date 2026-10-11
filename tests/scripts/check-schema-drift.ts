import { spawnSync } from "node:child_process";

const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

if (!shadowDatabaseUrl) {
  console.error("SHADOW_DATABASE_URL is required for schema drift checks");
  process.exit(1);
}

const command = process.platform === "win32" ? "cmd.exe" : "npx";
const args = [
  "prisma",
  "migrate",
  "diff",
  "--from-migrations",
  "prisma/migrations",
  "--to-schema-datamodel",
  "prisma/schema.prisma",
  "--shadow-database-url",
  shadowDatabaseUrl,
  "--exit-code"
];

const result = spawnSync(
  command,
  process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args,
  { stdio: "inherit" }
);

if (result.error) {
  console.error(`Schema drift check failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
