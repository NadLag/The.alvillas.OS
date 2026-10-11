import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  ReservationNotFoundError,
  completeAssignedFieldTask,
  createManualReservation,
  listAssignedFieldTasks,
  listOperationTasks
} from "@/modules/reservations/application/reservation-service";
import { pushSyncOps } from "@/modules/reservations/application/sync-service";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
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

const integrationActorId = "018f0a0b-0000-7000-9000-000000000701";
const integrationPersonId = "018f0a0b-0000-7000-9000-000000000702";

function actorForOrganization(
  organizationId: string,
  permissions = new Set([
    permissionKey("reservation", "view"),
    permissionKey("reservation", "create"),
    permissionKey("task", "view"),
    permissionKey("task", "create"),
    permissionKey("task", "edit")
  ])
): ReservationActorContext {
  const authContext: AuthContext = {
    organizationId,
    permissions,
    scopes: [{ organizationId }]
  };

  return {
    organizationId,
    actorId: integrationActorId,
    personId: integrationPersonId,
    authContext
  };
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
        const actorPerson = await tx.person.create({
          data: {
            id: integrationPersonId,
            organizationId: orgA.id,
            displayName: "Integration Field Worker",
            email: `integration-worker-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        await tx.userAccount.create({
          data: {
            id: integrationActorId,
            organizationId: orgA.id,
            personId: actorPerson.id,
            email: `integration-worker-account-${randomUUID()}@example.test`,
            status: "ACTIVE"
          }
        });
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

  it("creates manual reservations with idempotent task generation, overlap detection, and tenant isolation", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Reservations A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Reservations B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);

    const property = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "Reservation Owner",
            email: `reservation-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const createdProperty = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa Reservation Flow",
            addressLine1: "Route de Fes",
            city: "Marrakech",
            countryCode: "MA",
            propertyType: "Villa",
            bedrooms: 4,
            bathrooms: 4,
            livingSpaces: 2,
            maxGuests: 8,
            timezone: "Africa/Casablanca",
            amenities: ["pool"],
            photoUrls: [],
            propertyOwners: {
              create: {
                organizationId: orgA.id,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true,
                createdBy: integrationActorId
              }
            },
            createdBy: integrationActorId
          }
        });

        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "ops.reservation_task_templates",
            scopeType: "organization",
            scopeId: null,
            value: {
              tasks: [
                {
                  key: "arrival",
                  type: "ARRIVAL_PREPARATION",
                  title: {
                    en: "Arrival preparation",
                    fr: "Preparation arrivee"
                  },
                  due: "CHECK_IN",
                  priority: "NORMAL",
                  checklist: [
                    {
                      key: "bedrooms",
                      label: {
                        en: "Bedrooms ready",
                        fr: "Chambres pretes"
                      }
                    },
                    {
                      key: "bathrooms",
                      label: {
                        en: "Bathrooms ready",
                        fr: "Salles de bain pretes"
                      }
                    }
                  ]
                },
                {
                  key: "checkout",
                  type: "CHECKOUT_CLEANING",
                  title: {
                    en: "Checkout cleaning",
                    fr: "Menage depart"
                  },
                  due: "CHECK_OUT",
                  priority: "NORMAL",
                  checklist: [
                    {
                      key: "linen",
                      label: {
                        en: "Linen collected",
                        fr: "Linge collecte"
                      }
                    },
                    {
                      key: "cleaning",
                      label: {
                        en: "Cleaning completed",
                        fr: "Menage termine"
                      }
                    }
                  ]
                }
              ]
            },
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "Integration reservation task templates"
          }
        });

        return createdProperty;
      }
    );

    const ctx = actorForOrganization(orgA.id);
    const firstInput = {
      propertyId: property.id,
      guestName: "S3 Guest One",
      guestEmail: "s3.guest.one@example.test",
      source: "MANUAL" as const,
      checkIn: "2027-03-10",
      checkOut: "2027-03-14",
      adultCount: 2,
      childCount: 1,
      notes: "Manual reservation integration flow",
      idempotencyKey: randomUUID()
    };
    const first = await createManualReservation(ctx, firstInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-reservation-first",
      ipAddress: "127.0.0.1"
    });

    expect(first.idempotent).toBe(false);
    expect(first.reservation.reference).toBe("RES-0001");
    expect(first.conflictCount).toBe(0);
    expect(first.tasks.map((task) => task.title.en).sort()).toEqual([
      "Arrival preparation",
      "Checkout cleaning"
    ]);

    const replay = await createManualReservation(ctx, firstInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-reservation-replay",
      ipAddress: "127.0.0.1"
    });

    expect(replay.idempotent).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.tasks).toHaveLength(2);

    const overlapping = await createManualReservation(
      ctx,
      {
        ...firstInput,
        guestName: "S3 Guest Two",
        guestEmail: "s3.guest.two@example.test",
        checkIn: "2027-03-12",
        checkOut: "2027-03-16",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-reservation-overlap",
        ipAddress: "127.0.0.1"
      }
    );

    expect(overlapping.conflictCount).toBe(1);

    const tasks = await listOperationTasks(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task) => task.assignedToUserAccountId === integrationActorId)).toBe(true);

    const fieldTasks = await listAssignedFieldTasks(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(fieldTasks).toHaveLength(4);
    expect(fieldTasks[0]?.checklistItems).toHaveLength(2);

    const completed = await completeAssignedFieldTask(
      ctx,
      {
        taskId: fieldTasks[0].id,
        idempotencyKey: "018f0a0b-0000-7000-9000-000000000801",
        checklistItemIds: fieldTasks[0].checklistItems.map((item) => item.id),
        note: "Integration field completion"
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-field-complete",
        ipAddress: "127.0.0.1"
      }
    );

    expect(completed.state).toBe("COMPLETED");
    expect(completed.completedByUserAccountId).toBe(integrationActorId);
    expect(completed.completionIdempotencyKey).toBe("018f0a0b-0000-7000-9000-000000000801");
    expect(completed.checklistItems.every((item) => item.completedAt)).toBe(true);

    const syncTask = fieldTasks[1];
    const syncPush = {
      device_id: "integration-device-field-01",
      op_schema_version: 1 as const,
      ops: [
        {
          client_op_id: "018f0a0b-0000-7000-9000-000000000802",
          type: "field_task.complete" as const,
          payload: {
            taskId: syncTask.id,
            checklistItemIds: syncTask.checklistItems.map((item) => item.id),
            note: "Integration queued completion"
          },
          client_created_at: "2026-10-11T12:00:00.000Z"
        }
      ]
    };
    const synced = await pushSyncOps(ctx, syncPush, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-field-sync",
      ipAddress: "127.0.0.1"
    });
    const duplicate = await pushSyncOps(ctx, syncPush, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-field-sync-duplicate",
      ipAddress: "127.0.0.1"
    });

    expect(synced.results[0]).toMatchObject({
      client_op_id: "018f0a0b-0000-7000-9000-000000000802",
      status: "APPLIED"
    });
    expect(duplicate.results[0]).toMatchObject({
      client_op_id: "018f0a0b-0000-7000-9000-000000000802",
      status: "DUPLICATE"
    });

    const counts = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        reservations: await tx.reservation.count({ where: { propertyId: property.id } }),
        tasks: await tx.operationTask.count({ where: { propertyId: property.id } }),
        checkItems: await tx.operationTaskChecklistItem.count({ where: { organizationId: orgA.id } }),
        syncOps: await tx.syncOp.count({ where: { organizationId: orgA.id } }),
        conflicts: await tx.reservationConflict.count({
          where: { reservationId: overlapping.reservation.id }
        }),
        audits: await tx.auditLog.findMany({
          where: {
            action: {
              in: ["reservation.create", "reservation.conflict.detected", "task.create", "task.complete"]
            }
          },
          select: { action: true },
          orderBy: { occurredAt: "asc" }
        })
      })
    );

    expect(counts).toMatchObject({
      reservations: 2,
      tasks: 4,
      checkItems: 8,
      syncOps: 1,
      conflicts: 1
    });
    expect(counts.audits.map((audit) => audit.action).sort()).toEqual([
      "reservation.conflict.detected",
      "reservation.create",
      "reservation.create",
      "task.complete",
      "task.complete",
      "task.create",
      "task.create",
      "task.create",
      "task.create"
    ]);

    const reservationVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.reservation.findFirst({ where: { id: first.reservation.id } })
    );
    const taskVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.operationTask.findFirst({ where: { reservationId: first.reservation.id } })
    );
    const conflictVisibleWithoutTenant = await prisma.reservationConflict.findFirst({
      where: { reservationId: overlapping.reservation.id }
    });
    const checklistVisibleWithoutTenant = await prisma.operationTaskChecklistItem.findFirst({
      where: { taskId: completed.id }
    });

    expect(reservationVisibleToOrgB).toBeNull();
    expect(taskVisibleToOrgB).toBeNull();
    expect(conflictVisibleWithoutTenant).toBeNull();
    expect(checklistVisibleWithoutTenant).toBeNull();

    await expect(
      completeAssignedFieldTask(
        actorForOrganization(orgB.id),
        {
          taskId: completed.id,
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000803",
          checklistItemIds: completed.checklistItems.map((item) => item.id)
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-field-cross-tenant",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationNotFoundError);

    await expect(
      createManualReservation(actorForOrganization(orgB.id), firstInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-reservation-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
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
