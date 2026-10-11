import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

let prisma: PrismaClient;
let adminPrisma: PrismaClient | undefined;
let containerName: string;
let ownsContainer = false;

function runNpx(args: string[], env: NodeJS.ProcessEnv): void {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;

  execFileSync(command, commandArgs, {
    env,
    stdio: "inherit"
  });
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function waitForPostgres(name: string): void {
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-d", "alvillas_os"], {
        stdio: "ignore"
      });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }

  throw new Error("PostgreSQL test container did not become ready");
}

function publishedPort(name: string): string {
  const output = docker(["port", name, "5432/tcp"]);
  const firstLine = output.split(/\r?\n/u)[0];
  const port = firstLine?.split(":").at(-1);

  if (!port) {
    throw new Error(`Could not read published PostgreSQL port from: ${output}`);
  }

  return port;
}

function migrationNames(): string[] {
  return readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function appRoleUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "alvillas_app_test";
  url.password = "alvillas_app_test";
  return url.toString();
}

async function configureAppRole(databaseUrl: string): Promise<string> {
  adminPrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });

  await adminPrisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alvillas_app_test') THEN
        CREATE ROLE alvillas_app_test LOGIN;
      END IF;
    END
    $$;
  `);
  await adminPrisma.$executeRawUnsafe(
    "ALTER ROLE alvillas_app_test WITH LOGIN PASSWORD 'alvillas_app_test'"
  );
  await adminPrisma.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO alvillas_app_test");
  await adminPrisma.$executeRawUnsafe(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alvillas_app_test"
  );
  await adminPrisma.$executeRawUnsafe("REVOKE UPDATE, DELETE ON audit_log FROM alvillas_app_test");

  return appRoleUrl(databaseUrl);
}

describe("PostgreSQL baseline", () => {
  beforeAll(async () => {
    let databaseUrl = process.env.TEST_DATABASE_URL;

    if (databaseUrl) {
      const url = new URL(databaseUrl);
      if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        throw new Error("TEST_DATABASE_URL must point at a local test database");
      }
    } else {
      containerName = `alvillas-os-test-${Date.now()}`;
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
      ownsContainer = true;
      waitForPostgres(containerName);
      databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${publishedPort(
        containerName
      )}/alvillas_os?schema=public`;
    }

    runNpx(["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: databaseUrl });

    databaseUrl = await configureAppRole(databaseUrl);

    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } }
    });
  }, 120000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await adminPrisma?.$disconnect();
    if (ownsContainer && containerName) {
      execFileSync("docker", ["stop", containerName], { stdio: "ignore" });
    }
  });

  it("applies all migrations against an empty PostgreSQL database", async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations"
      ORDER BY migration_name
    `;

    expect(rows.map((row) => row.migration_name)).toEqual(migrationNames());
  });

  it("enforces audit log append-only behavior", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Test", baseCurrency: "MAD" }
    });
    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: org.id,
            action: "test.audit",
            resourceType: "organization",
            resourceId: org.id,
            requestId: "test-request"
          }
        })
    );

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.auditLog.update({
          where: { id: audit.id },
          data: { reason: "should fail" }
        })
      )
    ).rejects.toThrow(/append-only|permission denied/u);
  });

  it("enforces tenant isolation with PostgreSQL RLS", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: "ALVILLAS RLS A", baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: "ALVILLAS RLS B", baseCurrency: "MAD" }
      })
    ]);

    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: orgA.id,
            action: "test.rls",
            resourceType: "organization",
            resourceId: orgA.id,
            requestId: "test-request-rls"
          }
        })
    );

    const visibleToOrgA = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.auditLog.findFirst({ where: { id: audit.id } })
    );
    const visibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.auditLog.findFirst({ where: { id: audit.id } })
    );
    const visibleWithoutTenant = await prisma.auditLog.findFirst({ where: { id: audit.id } });

    expect(visibleToOrgA?.id).toBe(audit.id);
    expect(visibleToOrgB).toBeNull();
    expect(visibleWithoutTenant).toBeNull();
  });

  it("enforces owner and property tenant isolation with PostgreSQL RLS", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: "ALVILLAS Core RLS A", baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: "ALVILLAS Core RLS B", baseCurrency: "MAD" }
      })
    ]);

    const created = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "Scoped Owner",
            email: "scoped-owner@example.test",
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Scoped",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool", "garden"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true
              }
            }
          }
        });

        return { owner, property };
      }
    );

    const ownerVisibleToOrgA = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.owner.findFirst({ where: { id: created.owner.id } })
    );
    const ownerVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.owner.findFirst({ where: { id: created.owner.id } })
    );
    const propertyVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.property.findFirst({ where: { id: created.property.id } })
    );
    const linkVisibleWithoutTenant = await prisma.propertyOwner.findFirst({
      where: { propertyId: created.property.id }
    });

    expect(ownerVisibleToOrgA?.id).toBe(created.owner.id);
    expect(ownerVisibleToOrgB).toBeNull();
    expect(propertyVisibleToOrgB).toBeNull();
    expect(linkVisibleWithoutTenant).toBeNull();
  });

  it("allocates tenant-scoped reference numbers under RLS", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS References", baseCurrency: "MAD" }
    });

    const sequence = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) =>
        tx.referenceSequence.create({
          data: {
            organizationId: org.id,
            prefix: "RES",
            nextValue: 2,
            width: 4
          }
        })
    );

    await expect(
      prisma.referenceSequence.findUnique({
        where: { organizationId_prefix: { organizationId: org.id, prefix: "RES" } }
      })
    ).resolves.toBeNull();

    expect(sequence.nextValue).toBe(2n);
  });

  it("enforces balanced append-only ledger transactions", async () => {
    const org = await prisma.organization.create({
      data: { name: "ALVILLAS Ledger", baseCurrency: "MAD" }
    });

    const { bank, ownerPayable, transaction } = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) => {
        const createdBank = await tx.ledgerAccount.create({
          data: {
            organizationId: org.id,
            code: "BANK_A",
            name: "Bank A",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
          }
        });
        const createdOwnerPayable = await tx.ledgerAccount.create({
          data: {
            organizationId: org.id,
            code: "OWNER_PAYABLE",
            name: "Owner Payable",
            accountType: "CLAIM_OWNERSHIP",
            normalSide: "CREDIT"
          }
        });
        const createdTransaction = await tx.financialTransaction.create({
          data: {
            organizationId: org.id,
            reference: "TX-0001",
            occurredAt: new Date("2026-10-11T00:00:00.000Z"),
            postings: {
              create: [
                {
                  organizationId: org.id,
                  ledgerAccountId: createdBank.id,
                  side: "DEBIT",
                  amount: "8000.00",
                  currency: "MAD",
                  bucket: "OWNER_REVENUE"
                },
                {
                  organizationId: org.id,
                  ledgerAccountId: createdOwnerPayable.id,
                  side: "CREDIT",
                  amount: "8000.00",
                  currency: "MAD",
                  bucket: "OWNER_REVENUE"
                }
              ]
            }
          }
        });

        return {
          bank: createdBank,
          ownerPayable: createdOwnerPayable,
          transaction: createdTransaction
        };
      }
    );
    const posting = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      org.id,
      async (tx) => tx.posting.findFirstOrThrow({ where: { transactionId: transaction.id } })
    );

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.posting.update({
          where: { id: posting.id },
          data: { amount: "1.00" }
        })
      )
    ).rejects.toThrow();

    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, org.id, async (tx) =>
        tx.financialTransaction.create({
          data: {
            organizationId: org.id,
            reference: "TX-0002",
            occurredAt: new Date("2026-10-11T01:00:00.000Z"),
            postings: {
              create: [
                {
                  organizationId: org.id,
                  ledgerAccountId: bank.id,
                  side: "DEBIT",
                  amount: "100.00",
                  currency: "MAD"
                },
                {
                  organizationId: org.id,
                  ledgerAccountId: ownerPayable.id,
                  side: "CREDIT",
                  amount: "99.99",
                  currency: "MAD"
                }
              ]
            }
          }
        })
      )
    ).rejects.toThrow(/not balanced/u);

    expect(transaction.reference).toBe("TX-0001");
  });
});
