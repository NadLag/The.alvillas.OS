import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";

const roles = ["alvillas_app_test", "alvillas_team_tests", "alvillas_ops_tests"] as const;
let control: PrismaClient;
const databases: Array<{ url: URL; admin: PrismaClient }> = [];
beforeAll(async () => {
  const value = process.env.TEST_DATABASE_URL, source = value ? new URL(value) : null;
  if (!source || !["127.0.0.1", "localhost"].includes(source.hostname) || !(source.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && source.pathname === "/alvillas_os")) throw Error("Owned role-provisioning acceptance cluster required");
  control = new PrismaClient({ datasourceUrl: source.toString() });
  for (let index = 0; index < 2; index++) {
    const name = "alvillas_automation_role_" + randomUUID().replaceAll("-", "").slice(0, 20);
    await control.$executeRawUnsafe('CREATE DATABASE "' + name + '"'); const url = new URL(source); url.pathname = "/" + name;
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", resolve("prisma/schema.prisma")], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: "pipe" });
    databases.push({ url, admin: new PrismaClient({ datasourceUrl: url.toString() }) });
  }
}, 120000);
afterAll(async () => { await Promise.all(databases.map(database => database.admin.$disconnect())); await control?.$disconnect(); });

describe("shared PostgreSQL test-role provisioning", () => {
  it("provisions cluster roles concurrently across databases while preserving scoped privileges", async () => {
    for (const role of roles) {
      for (let round = 0; round < 8; round++) await Promise.all(databases.map(database => provisionIntegrationRole(database.admin, role)));
      for (const database of databases) {
        const url = new URL(database.url); url.username = url.password = role;
        const scoped = new PrismaClient({ datasourceUrl: url.toString() });
        try {
          expect(await scoped.$queryRaw<Array<{ name: string; superuser: boolean; bypass: boolean; readPosting: boolean; updateAudit: boolean; deleteAudit: boolean }>>`
            SELECT current_user::text AS name,rolsuper AS superuser,rolbypassrls AS bypass,
              has_table_privilege(current_user,'posting','SELECT') AS "readPosting",
              has_table_privilege(current_user,'audit_log','UPDATE') AS "updateAudit",
              has_table_privilege(current_user,'audit_log','DELETE') AS "deleteAudit"
            FROM pg_roles WHERE rolname=current_user
          `).toEqual([{ name: role, superuser: false, bypass: false, readPosting: true, updateAudit: false, deleteAudit: false }]);
        } finally { await scoped.$disconnect(); }
      }
    }
  });
});
