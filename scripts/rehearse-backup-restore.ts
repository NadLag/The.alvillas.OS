import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { withTenant } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { HouseholdRepository } from "@/modules/personal/infrastructure/household-repository";
import { PersonalDocumentRepository } from "@/modules/personal/infrastructure/personal-document-repository";

type RehearsalDatabase = { databaseUrl: string } & (
  | { containerName: string }
  | { databaseName: string; postgresEnvironment: NodeJS.ProcessEnv }
);

const specimen = Buffer.from("%PDF-1.7\n%%EOF");
const restoredTables = ["financial_transaction", "posting", "personal_document", "personal_audit_event", "audit_log"];

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function runInherited(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, {
    env,
    stdio: "inherit"
  });
}

function runNpx(args: string[], env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") {
    runInherited("cmd.exe", ["/d", "/s", "/c", "npx.cmd", ...args], env);
    return;
  }

  runInherited("npx", args, env);
}

function docker(args: string[]): string {
  return run("docker", args);
}

function waitForPostgres(containerName: string): void {
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    if (canRunSql(containerName)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      if (canRunSql(containerName)) {
        return;
      }
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }

  throw new Error(`PostgreSQL container ${containerName} did not become ready`);
}

function canRunSql(containerName: string): boolean {
  try {
    execFileSync(
      "docker",
      ["exec", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "SELECT 1"],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

function ensureRehearsalDatabase(containerName: string): void {
  const exists = run("docker", [
    "exec",
    containerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tAc",
    "SELECT 1 FROM pg_database WHERE datname = 'alvillas_os'"
  ]);

  if (exists !== "1") {
    runInherited("docker", ["exec", containerName, "createdb", "-U", "postgres", "alvillas_os"]);
  }
}

function publishedPort(containerName: string): string {
  const output = docker(["port", containerName, "5432/tcp"]);
  const firstLine = output.split(/\r?\n/u)[0];
  const port = firstLine?.split(":").at(-1);

  if (!port) {
    throw new Error(`Could not read published PostgreSQL port from: ${output}`);
  }

  return port;
}

function startContainer(label: string): RehearsalDatabase {
  const containerName = `alvillas-os-restore-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=alvillas_os",
    "-p",
    "5432",
    "postgres:17-alpine"
  ]);
  waitForPostgres(containerName);
  ensureRehearsalDatabase(containerName);

  return {
    containerName,
    databaseUrl: `postgresql://postgres:postgres@127.0.0.1:${publishedPort(
      containerName
    )}/alvillas_os?schema=public`
  };
}

function startDatabase(label: string): RehearsalDatabase {
  const configured = process.env.REHEARSAL_LOCAL_POSTGRES_URL;
  if (!configured) return startContainer(label);
  const server = new URL(configured);
  if (server.protocol !== "postgresql:" || server.hostname !== "127.0.0.1" || !server.port
    || server.pathname !== "/postgres" || !server.username || server.search || server.hash) {
    throw new Error("Local restore rehearsal requires an explicit PostgreSQL loopback maintenance database");
  }
  const databaseName = `alvillas_restore_${label}_${randomUUID().replaceAll("-", "")}`;
  const postgresEnvironment = {
    ...process.env,
    PGHOST: server.hostname, PGPORT: server.port,
    PGUSER: decodeURIComponent(server.username), PGPASSWORD: decodeURIComponent(server.password), PGDATABASE: "postgres"
  };
  runInherited("createdb", [databaseName], postgresEnvironment);
  server.pathname = `/${databaseName}`;
  server.search = "schema=public";
  return { databaseName, databaseUrl: server.toString(), postgresEnvironment };
}

function backup(database: RehearsalDatabase, path: string) {
  const options = ["--format=custom", "--no-owner", "--no-privileges"];
  if ("databaseName" in database) {
    runInherited("pg_dump", ["--dbname", database.databaseName, ...options, "--file", path], database.postgresEnvironment);
    return;
  }
  const containerPath = "/tmp/alvillas-os.dump";
  runInherited("docker", ["exec", database.containerName, "pg_dump", "-U", "postgres", "-d", "alvillas_os",
    ...options, "--file", containerPath]);
  runInherited("docker", ["cp", `${database.containerName}:${containerPath}`, path]);
}

function restore(database: RehearsalDatabase, path: string) {
  const options = ["--no-owner", "--no-privileges", "--exit-on-error"];
  if ("databaseName" in database) {
    runInherited("pg_restore", ["--dbname", database.databaseName, ...options, path], database.postgresEnvironment);
    return;
  }
  const containerPath = "/tmp/alvillas-os.dump";
  runInherited("docker", ["cp", path, `${database.containerName}:${containerPath}`]);
  runInherited("docker", ["exec", database.containerName, "pg_restore", "-U", "postgres", "-d", "alvillas_os",
    ...options, containerPath]);
}

async function writeRehearsalEvidence(databaseUrl: string) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const { id: organizationId } = await db.organization.create({
      data: { name: "ALVILLAS isolated restore fixture", baseCurrency: "MAD" }
    });
    const { actor, journal } = await withTenant(db, organizationId, async (tx) => {
      const person = await tx.person.create({ data: { organizationId, displayName: "Restore fixture operator" } });
      const { id: accountId } = await tx.userAccount.create({ data: { organizationId, personId: person.id } });
      const repository = new FinanceRepository(tx, organizationId);
      const bank = await repository.ensureLedgerAccount({ code: "RESTORE_BANK", name: "Fixture bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
      const capital = await repository.ensureLedgerAccount({ code: "RESTORE_CAPITAL", name: "Fixture capital", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
      const amount = Money.of("9007199254740993.07", "MAD");
      const now = new Date();
      const journal = await repository.createFinancialTransaction({
        reference: "RESTORE-" + randomUUID(), occurredAt: now, description: "Synthetic exact-money recovery witness",
        idempotencyKey: randomUUID(), createdBy: accountId, postings: [
          { ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: null, dimensions: {} },
          { ledgerAccountId: capital.id, side: "CREDIT", amount, bucket: null, dimensions: {} }
        ]
      });
      await writeAuditEvent(tx, { organizationId, actorId: accountId, action: "backup.restore.rehearsal", resourceType: "organization",
        resourceId: organizationId, requestId: "restore-rehearsal", occurredAt: now });
      return { actor: { organizationId, accountId }, journal };
    });
    const households = new HouseholdRepository(db);
    const householdId = await households.provision(actor, "Restore fixture household", "Fixture steward");
    const documentId = await households.scoped(actor, householdId, async (scope) => {
      const documents = new PersonalDocumentRepository(scope);
      await documents.upload({ id: randomUUID(), displayName: "Fixture document",
        file: new File([specimen], "fixture.pdf", { type: "application/pdf" }) });
      return (await documents.list(false)).items[0].id;
    });
    return { actor, householdId, documentId, journalId: journal.id };
  } finally {
    await db.$disconnect();
  }
}

type Evidence = Awaited<ReturnType<typeof writeRehearsalEvidence>>;

async function evidenceSnapshot(databaseUrl: string, evidence: Evidence) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const { actor, householdId, documentId, journalId } = evidence;
  const { organizationId } = actor;
  try {
    const [migrations, policies, business, personal] = await Promise.all([
      db.$queryRaw<{ id: string; migration_name: string; checksum: string }[]>`
        SELECT id, migration_name, checksum FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
      db.$queryRaw<{ table: string; rls: boolean; force: boolean; policyCount: bigint }[]>`
        SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
          (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS "policyCount"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(${restoredTables}::text[]) ORDER BY c.relname`,
      withTenant(db, organizationId, async (tx) => ({
        journal: await tx.financialTransaction.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: journalId } },
          include: { postings: { orderBy: { id: "asc" } } }
        }),
        auditCount: await tx.auditLog.count({ where: { organizationId, action: "backup.restore.rehearsal" } })
      })),
      new HouseholdRepository(db).scoped(actor, householdId, async (scope) => {
        const encrypted = await scope.tx.personalDocument.findUniqueOrThrow({
          where: { organizationId_householdId_id: { ...scope.key, id: documentId } },
          select: { ciphertext: true, contentHash: true }
        });
        const auditCount = await scope.tx.personalAuditEvent.count({
          where: { ...scope.key, action: "personal.document_uploaded", resourceId: documentId }
        });
        return { encrypted, auditCount };
      })
    ]);
    assert(migrations.length > 0);
    assert.equal(policies.length, restoredTables.length);
    assert(policies.every((row) => row.rls && row.force && row.policyCount > 0n));
    assert.equal(business.auditCount, 1);
    assert.equal(business.journal.sealed, true);
    assert.equal(business.journal.postings.length, 2);
    assert(business.journal.postings.every((posting) => posting.amount.toFixed(2) === "9007199254740993.07"));
    assert.equal(personal.auditCount, 1);
    return { migrations, policies, business, personal };
  } finally {
    await db.$disconnect();
  }
}

async function verifyDocumentRecovery(databaseUrl: string, evidence: Evidence) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const file = await new HouseholdRepository(db).scoped(evidence.actor, evidence.householdId,
      (scope) => new PersonalDocumentRepository(scope).download(evidence.documentId));
    assert(file);
    assert.deepEqual(Buffer.from(file.bytes), specimen);
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "alvillas-restore-"));
  const dumpPath = join(workspace, "alvillas-os.dump");
  const databases: RehearsalDatabase[] = [];
  const originalKeys = process.env.PERSONAL_ENCRYPTION_KEYS;
  process.env.PERSONAL_ENCRYPTION_KEYS = "rehearsal:" + randomBytes(32).toString("base64");

  try {
    const source = startDatabase("source");
    databases.push(source);
    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: source.databaseUrl });
    const evidence = await writeRehearsalEvidence(source.databaseUrl);
    const original = await evidenceSnapshot(source.databaseUrl, evidence);
    backup(source, dumpPath);
    if (!existsSync(dumpPath)) throw new Error("pg_dump did not create a backup artifact");

    const target = startDatabase("target");
    databases.push(target);
    restore(target, dumpPath);
    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: target.databaseUrl });
    assert.deepEqual(await evidenceSnapshot(target.databaseUrl, evidence), original);
    await verifyDocumentRecovery(target.databaseUrl, evidence);
    console.log(JSON.stringify({
      status: "ok", migrationCount: original.migrations.length, tenantPolicies: original.policies.length,
      ledgerPostings: original.business.journal.postings.length, auditCount: original.business.auditCount,
      protectedDocumentRecovered: true
    }));
  } finally {
    if (originalKeys === undefined) delete process.env.PERSONAL_ENCRYPTION_KEYS;
    else process.env.PERSONAL_ENCRYPTION_KEYS = originalKeys;
    for (const database of databases.reverse()) {
      try {
        if ("databaseName" in database) {
          runInherited("dropdb", ["--if-exists", "--force", database.databaseName], database.postgresEnvironment);
        } else {
          execFileSync("docker", ["stop", database.containerName], { stdio: "ignore" });
        }
      } catch {
        console.warn("Could not clean up a disposable restore database");
      }
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
