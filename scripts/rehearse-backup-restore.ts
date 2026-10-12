import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

type RehearsalDatabase = {
  containerName: string;
  databaseUrl: string;
};

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

function startDatabase(label: string): RehearsalDatabase {
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

async function writeRehearsalEvidence(databaseUrl: string): Promise<string> {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });

  try {
    const organization = await prisma.organization.create({
      data: {
        name: `ALVILLAS Restore Rehearsal ${new Date().toISOString()}`,
        baseCurrency: "MAD"
      }
    });

    await prisma.auditLog.create({
      data: {
        organizationId: organization.id,
        action: "backup.restore.rehearsal",
        resourceType: "organization",
        resourceId: organization.id,
        requestId: "restore-rehearsal"
      }
    });

    return organization.id;
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyRestoredDatabase(databaseUrl: string, organizationId: string): Promise<{
  migrationCount: number;
  organizationCount: number;
  auditCount: number;
}> {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });

  try {
    const [migrationRows, organizationCount, auditCount] = await Promise.all([
      prisma.$queryRaw<Array<{ migrationCount: number }>>`
        SELECT COUNT(*)::int AS "migrationCount" FROM "_prisma_migrations"
      `,
      prisma.organization.count({ where: { id: organizationId } }),
      prisma.auditLog.count({
        where: {
          organizationId,
          action: "backup.restore.rehearsal"
        }
      })
    ]);

    return {
      migrationCount: migrationRows[0]?.migrationCount ?? 0,
      organizationCount,
      auditCount
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "alvillas-restore-"));
  const dumpPath = join(workspace, "alvillas-os.dump");
  const containers: string[] = [];

  try {
    const source = startDatabase("source");
    containers.push(source.containerName);
    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: source.databaseUrl });
    const organizationId = await writeRehearsalEvidence(source.databaseUrl);

    const containerDumpPath = "/tmp/alvillas-os.dump";
    runInherited("docker", [
      "exec",
      source.containerName,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "alvillas_os",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      containerDumpPath
    ]);
    runInherited("docker", ["cp", `${source.containerName}:${containerDumpPath}`, dumpPath]);

    if (!existsSync(dumpPath)) {
      throw new Error("pg_dump did not create a backup artifact");
    }

    const target = startDatabase("target");
    containers.push(target.containerName);
    runInherited("docker", ["cp", dumpPath, `${target.containerName}:${containerDumpPath}`]);
    runInherited("docker", [
      "exec",
      target.containerName,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "alvillas_os",
      "--no-owner",
      "--no-privileges",
      containerDumpPath
    ]);
    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: target.databaseUrl });

    const verification = await verifyRestoredDatabase(target.databaseUrl, organizationId);

    if (verification.migrationCount < 1 || verification.organizationCount !== 1 || verification.auditCount !== 1) {
      throw new Error(`Restore verification failed: ${JSON.stringify(verification)}`);
    }

    console.log(
      JSON.stringify({
        status: "ok",
        migrationCount: verification.migrationCount,
        organizationCount: verification.organizationCount,
        auditCount: verification.auditCount
      })
    );
  } finally {
    for (const containerName of containers.reverse()) {
      try {
        execFileSync("docker", ["stop", containerName], { stdio: "ignore" });
      } catch {
        // Rehearsal cleanup is best-effort after a failed start/stop race.
      }
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
