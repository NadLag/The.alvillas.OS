import { PrismaClient } from "@prisma/client";
import { readServiceInfo, type ServiceInfo, type ServiceInfoEnv } from "./service-info";
import { readProviderStatuses } from "@/platform/providers/status";

export type ReadinessCheck = {
  name: string;
  status: "ok" | "missing" | "error";
  detail?: string;
  required?: boolean;
};

export type ReadinessResult = {
  status: "ready" | "not_ready";
  service: ServiceInfo;
  checks: ReadinessCheck[];
};

type MigrationSummary = {
  migrationCount: number;
};

type ReadinessEnv = ServiceInfoEnv &
  Record<string, string | undefined> & {
    DATABASE_URL?: string;
    AUTH_SECRET?: string;
    ALVILLAS_STRICT_READINESS?: string;
    NODE_ENV?: string;
  };

type ReadinessOptions = {
  env?: ReadinessEnv;
  now?: Date;
  migrationSummary?: () => Promise<MigrationSummary>;
};

let prisma: PrismaClient | undefined;

function getPrisma(): PrismaClient {
  prisma ??= new PrismaClient();
  return prisma;
}

async function readMigrationSummary(): Promise<MigrationSummary> {
  const rows = await getPrisma().$queryRaw<Array<{ migrationCount: number }>>`
    SELECT COUNT(*)::int AS "migrationCount" FROM "_prisma_migrations"
  `;

  return { migrationCount: rows[0]?.migrationCount ?? 0 };
}

export async function checkReadiness(options: ReadinessOptions = {}): Promise<ReadinessResult> {
  const env = options.env ?? process.env;
  const checks: ReadinessCheck[] = [];
  const migrationSummary = options.migrationSummary ?? readMigrationSummary;
  const strictReadiness = env.ALVILLAS_STRICT_READINESS === "1";

  if (!env.DATABASE_URL) {
    checks.push({
      name: "database",
      status: "missing",
      detail: "DATABASE_URL is not configured"
    });
  } else {
    try {
      const summary = await migrationSummary();
      checks.push({
        name: "database",
        status: summary.migrationCount > 0 ? "ok" : "error",
        detail:
          summary.migrationCount > 0
            ? `${summary.migrationCount} migrations applied`
            : "No Prisma migrations found"
      });
    } catch (error) {
      checks.push({
        name: "database",
        status: "error",
        detail: error instanceof Error ? error.message : "Database readiness check failed"
      });
    }
  }

  if (!env.AUTH_SECRET && env.NODE_ENV === "production") {
    checks.push({
      name: "auth_secret",
      status: "missing",
      detail: "AUTH_SECRET is required in production",
      required: true
    });
  }

  for (const provider of readProviderStatuses(env)) {
    checks.push({
      name: `provider:${provider.name}`,
      status: provider.status === "configured" ? "ok" : "missing",
      detail: provider.detail,
      required: strictReadiness
    });
  }

  return {
    status: checks.every((check) => check.status === "ok" || check.required === false)
      ? "ready"
      : "not_ready",
    service: readServiceInfo(env, options.now),
    checks
  };
}
