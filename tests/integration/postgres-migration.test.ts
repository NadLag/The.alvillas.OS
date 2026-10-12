import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import type { Session } from "next-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import {
  getOwnerStatement,
  listOwnerPortalProperties,
  OwnerPortalAuthorizationError
} from "@/modules/owner-portal/application/owner-portal-service";
import {
  ReservationRevenueAuthorizationError,
  ReservationRevenueConflictError,
  ReservationRevenueNotFoundError,
  recordReservationAccommodationRevenue,
  reverseReservationAccommodationRevenue
} from "@/modules/finance/application/reservation-revenue-service";
import {
  AirbnbSettlementAuthorizationError,
  AirbnbSettlementConflictError,
  AirbnbSettlementNotFoundError,
  importAirbnbSettlementCsv,
  listAirbnbSettlementVariances,
  reverseAirbnbSettlement
} from "@/modules/finance/application/airbnb-settlement-service";
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

function sessionForOwnerPortal(input: {
  organizationId: string;
  userAccountId: string;
  personId: string;
  email: string;
}): Session {
  return {
    user: {
      id: input.userAccountId,
      personId: input.personId,
      organizationId: input.organizationId,
      preferredLocale: "en",
      sessionId: "integration-session",
      sessionRevoked: false,
      email: input.email,
      name: input.email
    },
    expires: new Date("2099-01-01T00:00:00.000Z").toISOString()
  };
}

function signedLedgerAmount(row: { side: string; amount: string }): Decimal {
  const amount = new Decimal(row.amount);
  return row.side === "CREDIT" ? amount : amount.negated();
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

  it("derives owner portal statements from PostgreSQL ledger postings and owner scopes", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Portal A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Owner Portal B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const ownerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-a-${randomUUID()}@example.test`
    };
    const otherOwnerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-b-${randomUUID()}@example.test`
    };
    const tenantUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `tenant-${randomUUID()}@example.test`
    };
    const orgBUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `owner-org-b-${randomUUID()}@example.test`
    };

    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const ownerPerson = await tx.person.create({
          data: {
            id: ownerUser.personId,
            organizationId: orgA.id,
            displayName: "Owner Portal Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const ownerAccount = await tx.userAccount.create({
          data: {
            id: ownerUser.userAccountId,
            organizationId: orgA.id,
            personId: ownerPerson.id,
            email: ownerUser.email,
            status: "ACTIVE"
          }
        });
        const otherPerson = await tx.person.create({
          data: {
            id: otherOwnerUser.personId,
            organizationId: orgA.id,
            displayName: "Other Owner Portal Owner",
            email: otherOwnerUser.email,
            preferredLocale: "en"
          }
        });
        const otherAccount = await tx.userAccount.create({
          data: {
            id: otherOwnerUser.userAccountId,
            organizationId: orgA.id,
            personId: otherPerson.id,
            email: otherOwnerUser.email,
            status: "ACTIVE"
          }
        });
        const tenantPerson = await tx.person.create({
          data: {
            id: tenantUser.personId,
            organizationId: orgA.id,
            displayName: "Tenant User Without Owner Scope",
            email: tenantUser.email,
            preferredLocale: "en"
          }
        });
        await tx.userAccount.create({
          data: {
            id: tenantUser.userAccountId,
            organizationId: orgA.id,
            personId: tenantPerson.id,
            email: tenantUser.email,
            status: "ACTIVE"
          }
        });
        const [owner, otherOwner] = await Promise.all([
          tx.owner.create({
            data: {
              organizationId: orgA.id,
              displayName: "Owner Portal Owner",
              email: ownerUser.email,
              preferredLocale: "en"
            }
          }),
          tx.owner.create({
            data: {
              organizationId: orgA.id,
              displayName: "Other Owner",
              email: otherOwnerUser.email,
              preferredLocale: "en"
            }
          })
        ]);
        const [property, otherProperty] = await Promise.all([
          tx.property.create({
            data: {
              organizationId: orgA.id,
              name: "Villa Ledger Scope",
              addressLine1: "Route de Fes",
              city: "Marrakech",
              countryCode: "MA",
              propertyType: "Villa",
              bedrooms: 4,
              bathrooms: 4,
              livingSpaces: 2,
              maxGuests: 8,
              timezone: "Africa/Casablanca",
              amenities: [],
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
          }),
          tx.property.create({
            data: {
              organizationId: orgA.id,
              name: "Villa Other Owner",
              addressLine1: "Route de Fes",
              city: "Marrakech",
              countryCode: "MA",
              propertyType: "Villa",
              bedrooms: 5,
              bathrooms: 5,
              livingSpaces: 2,
              maxGuests: 10,
              timezone: "Africa/Casablanca",
              amenities: [],
              photoUrls: [],
              propertyOwners: {
                create: {
                  organizationId: orgA.id,
                  ownerId: otherOwner.id,
                  shareBps: 10000,
                  isPrimary: true
                }
              }
            }
          })
        ]);
        await Promise.all([
          tx.ownerPortalAccess.create({
            data: {
              organizationId: orgA.id,
              ownerId: owner.id,
              userAccountId: ownerAccount.id
            }
          }),
          tx.ownerPortalAccess.create({
            data: {
              organizationId: orgA.id,
              ownerId: otherOwner.id,
              userAccountId: otherAccount.id
            }
          })
        ]);
        const [bank, ownerPayable, commissionRevenue] = await Promise.all([
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "BANK_A_INTERNAL",
              name: "Operating bank",
              accountType: "ASSET_LOCATION",
              normalSide: "DEBIT"
            }
          }),
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "OWNER_PAYABLE",
              name: "Owner payable",
              accountType: "CLAIM_OWNERSHIP",
              normalSide: "CREDIT"
            }
          }),
          tx.ledgerAccount.create({
            data: {
              organizationId: orgA.id,
              code: "ALVILLAS_COMMISSION_REVENUE",
              name: "ALVILLAS commission revenue",
              accountType: "ALVILLAS_OWN",
              normalSide: "CREDIT"
            }
          })
        ]);
        const dimensions = {
          owner_id: owner.id,
          property_id: property.id,
          reservation_reference: "RES-OWNER-PORTAL",
          source: "DIRECT"
        };

        async function createOwnerPostingTransaction(input: {
          reference: string;
          occurredAt: Date;
          ownerSide: "DEBIT" | "CREDIT";
          amount: string;
          bucket: string;
          offsetAccountId: string;
          offsetSide: "DEBIT" | "CREDIT";
        }) {
          return tx.financialTransaction.create({
            data: {
              organizationId: orgA.id,
              reference: input.reference,
              occurredAt: input.occurredAt,
              description: input.bucket,
              postings: {
                create: [
                  {
                    organizationId: orgA.id,
                    ledgerAccountId: input.offsetAccountId,
                    side: input.offsetSide,
                    amount: input.amount,
                    currency: "MAD",
                    bucket: input.bucket,
                    dimensions
                  },
                  {
                    organizationId: orgA.id,
                    ledgerAccountId: ownerPayable.id,
                    side: input.ownerSide,
                    amount: input.amount,
                    currency: "MAD",
                    bucket: input.bucket,
                    dimensions
                  }
                ]
              }
            },
            include: {
              postings: true
            }
          });
        }

        await createOwnerPostingTransaction({
          reference: "TX-OPENING",
          occurredAt: new Date("2027-03-25T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "1000.00",
          bucket: "OWNER_REVENUE",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        const revenue = await createOwnerPostingTransaction({
          reference: "TX-REVENUE",
          occurredAt: new Date("2027-04-05T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "8000.00",
          bucket: "OWNER_REVENUE",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-SERVICE",
          occurredAt: new Date("2027-04-06T12:00:00.000Z"),
          ownerSide: "CREDIT",
          amount: "500.00",
          bucket: "OWNER_SERVICES",
          offsetAccountId: bank.id,
          offsetSide: "DEBIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-COMMISSION",
          occurredAt: new Date("2027-04-07T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "1600.00",
          bucket: "COMMISSION",
          offsetAccountId: commissionRevenue.id,
          offsetSide: "CREDIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-EXPENSE",
          occurredAt: new Date("2027-04-08T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "600.00",
          bucket: "OWNER_EXPENSE",
          offsetAccountId: bank.id,
          offsetSide: "CREDIT"
        });
        await createOwnerPostingTransaction({
          reference: "TX-PAYOUT",
          occurredAt: new Date("2027-04-20T12:00:00.000Z"),
          ownerSide: "DEBIT",
          amount: "2000.00",
          bucket: "PAYOUT",
          offsetAccountId: bank.id,
          offsetSide: "CREDIT"
        });

        const revenueOwnerPostingId = revenue.postings.find(
          (posting) => posting.ledgerAccountId === ownerPayable.id
        )?.id;

        if (!revenueOwnerPostingId) {
          throw new Error("Owner payable posting was not created");
        }

        return {
          owner,
          property,
          otherProperty,
          revenueOwnerPostingId
        };
      }
    );

    const ownerSession = sessionForOwnerPortal({
      organizationId: orgA.id,
      userAccountId: ownerUser.userAccountId,
      personId: ownerUser.personId,
      email: ownerUser.email
    });
    const ownerCtx = await ownerPortalActorContextFromSession(ownerSession, {
      db: prisma as unknown as TenantTransactionRunner
    });

    expect(ownerCtx).not.toBeNull();

    const properties = await listOwnerPortalProperties(ownerCtx!, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(properties.map((property) => property.propertyId)).toEqual([fixture.property.id]);

    const statement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2027-04-01", to: "2027-04-30" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-owner-statement",
        ipAddress: "127.0.0.1"
      }
    );

    expect(statement.openingBalance.toJSON().amount).toBe("1000.00");
    expect(statement.periodCreditTotal.toJSON().amount).toBe("8500.00");
    expect(statement.periodDebitTotal.toJSON().amount).toBe("4200.00");
    expect(statement.closingBalance.toJSON().amount).toBe("5300.00");
    expect(statement.lines.map((line) => line.bucket).sort()).toEqual([
      "COMMISSION",
      "OWNER_EXPENSE",
      "OWNER_REVENUE",
      "OWNER_SERVICES",
      "PAYOUT"
    ]);

    const postingRows = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.$queryRaw<Array<{ side: string; amount: string }>>`
          SELECT p.side, p.amount::text AS amount
          FROM posting p
          INNER JOIN ledger_account la ON la.id = p.ledger_account_id
          INNER JOIN financial_transaction ft ON ft.id = p.transaction_id
          WHERE p.organization_id = ${orgA.id}::uuid
            AND la.code = 'OWNER_PAYABLE'
            AND p.dimensions @> jsonb_build_object(
              'owner_id', ${fixture.owner.id},
              'property_id', ${fixture.property.id}
            )
            AND ft.occurred_at >= ${new Date("2027-04-01T00:00:00.000Z")}
            AND ft.occurred_at < ${new Date("2027-05-01T00:00:00.000Z")}
        `
    );
    const postingCreditTotal = postingRows
      .filter((row) => row.side === "CREDIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const postingDebitTotal = postingRows
      .filter((row) => row.side === "DEBIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const postingNet = postingRows
      .map(signedLedgerAmount)
      .reduce((sum, amount) => sum.plus(amount), new Decimal(1000));

    expect(statement.periodCreditTotal.toJSON().amount).toBe(postingCreditTotal.toFixed(2));
    expect(statement.periodDebitTotal.toJSON().amount).toBe(postingDebitTotal.toFixed(2));
    expect(statement.closingBalance.toJSON().amount).toBe(postingNet.toFixed(2));

    await expect(
      getOwnerStatement(
        ownerCtx!,
        fixture.otherProperty.id,
        { from: "2027-04-01", to: "2027-04-30" },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-owner-statement-other-owner",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(OwnerPortalAuthorizationError);

    const tenantSession = sessionForOwnerPortal({
      organizationId: orgA.id,
      userAccountId: tenantUser.userAccountId,
      personId: tenantUser.personId,
      email: tenantUser.email
    });
    await expect(
      ownerPortalActorContextFromSession(tenantSession, {
        db: prisma as unknown as TenantTransactionRunner
      })
    ).resolves.toBeNull();

    await withTenant(prisma as unknown as TenantTransactionRunner, orgB.id, async (tx) => {
      const person = await tx.person.create({
        data: {
          id: orgBUser.personId,
          organizationId: orgB.id,
          displayName: "Org B Owner",
          email: orgBUser.email,
          preferredLocale: "en"
        }
      });
      await tx.userAccount.create({
        data: {
          id: orgBUser.userAccountId,
          organizationId: orgB.id,
          personId: person.id,
          email: orgBUser.email,
          status: "ACTIVE"
        }
      });
    });
    const revenueVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.posting.findFirst({ where: { id: fixture.revenueOwnerPostingId } })
    );
    const audit = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) =>
        tx.auditLog.findFirst({
          where: {
            action: "owner_statement.view",
            resourceId: fixture.property.id
          }
        })
    );

    expect(revenueVisibleToOrgB).toBeNull();
    expect(audit?.resourceId).toBe(fixture.property.id);
  });

  it("posts manual reservation revenue to owner and ALVILLAS ledgers exactly once", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Revenue Posting A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Revenue Posting B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const financePermissions = new Set([
      permissionKey("reservation", "view"),
      permissionKey("reservation", "create"),
      permissionKey("task", "view"),
      permissionKey("task", "create"),
      permissionKey("financial_transaction", "view"),
      permissionKey("financial_transaction", "create"),
      permissionKey("financial_transaction", "void")
    ]);
    const ownerUser = {
      personId: randomUUID(),
      userAccountId: randomUUID(),
      email: `s6-owner-${randomUUID()}@example.test`
    };
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const ownerPerson = await tx.person.create({
          data: {
            id: ownerUser.personId,
            organizationId: orgA.id,
            displayName: "S6 Owner Portal Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const ownerAccount = await tx.userAccount.create({
          data: {
            id: ownerUser.userAccountId,
            organizationId: orgA.id,
            personId: ownerPerson.id,
            email: ownerUser.email,
            status: "ACTIVE"
          }
        });
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "S6 Revenue Owner",
            email: ownerUser.email,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa S6 Revenue",
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
        await tx.ownerPortalAccess.create({
          data: {
            organizationId: orgA.id,
            ownerId: owner.id,
            userAccountId: ownerAccount.id
          }
        });
        const bank = await tx.ledgerAccount.create({
          data: {
            organizationId: orgA.id,
            code: "BANK_S6_REVENUE",
            name: "S6 operating bank",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
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
                  checklist: []
                }
              ]
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 task templates"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "organization",
            scopeId: null,
            value: {
              rate_bps: 1000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 organization commission fallback"
          }
        });
        const propertyCommissionRule = await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "property",
            scopeId: property.id,
            value: {
              rate_bps: 2000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S6 property commission"
          }
        });
        await tx.configRule.create({
          data: {
            organizationId: orgA.id,
            key: "finance.commission",
            scopeType: "property",
            scopeId: property.id,
            value: {
              rate_bps: 3000,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
            version: 2,
            createdBy: integrationActorId,
            reason: "S6 future commission change"
          }
        });

        return {
          owner,
          property,
          bank,
          propertyCommissionRule
        };
      }
    );
    const ctx = actorForOrganization(orgA.id, financePermissions);
    const reservation = await createManualReservation(
      ctx,
      {
        propertyId: fixture.property.id,
        guestName: "S6 Revenue Guest",
        guestEmail: "s6.revenue.guest@example.test",
        source: "MANUAL",
        checkIn: "2028-04-10",
        checkOut: "2028-04-14",
        adultCount: 2,
        childCount: 0,
        notes: "S6 reservation revenue posting",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-reservation",
        ipAddress: "127.0.0.1"
      }
    );
    const recordInput = {
      reservationId: reservation.reservation.id,
      amount: "8000.00",
      currency: "MAD",
      receivedAccountId: fixture.bank.id,
      idempotencyKey: randomUUID()
    };

    await expect(
      recordReservationAccommodationRevenue(
        actorForOrganization(
          orgA.id,
          new Set([permissionKey("reservation", "view"), permissionKey("financial_transaction", "view")])
        ),
        recordInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueAuthorizationError);

    const posted = await recordReservationAccommodationRevenue(ctx, recordInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-record",
      ipAddress: "127.0.0.1"
    });

    expect(posted.idempotent).toBe(false);
    expect(posted.commissionTotal.toJSON().amount).toBe("1600.00");
    expect(posted.ownerNetTotal.toJSON().amount).toBe("6400.00");

    const afterPost = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        transactionCount: await tx.financialTransaction.count({
          where: { organizationId: orgA.id }
        }),
        snapshot: await tx.commissionSnapshot.findFirstOrThrow({
          where: {
            reservationId: reservation.reservation.id,
            ownerId: fixture.owner.id
          }
        }),
        postings: await tx.posting.findMany({
          where: {
            transactionId: {
              in: [posted.revenueTransactionId, posted.commissionTransactionId!]
            }
          },
          include: {
            ledgerAccount: true
          }
        }),
        balances: await tx.$queryRaw<Array<{ transactionId: string; balance: string }>>`
          SELECT
            transaction_id AS "transactionId",
            sum(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END)::text AS balance
          FROM posting
          WHERE organization_id = ${orgA.id}::uuid
            AND transaction_id IN (${posted.revenueTransactionId}::uuid, ${posted.commissionTransactionId!}::uuid)
          GROUP BY transaction_id
        `
      })
    );

    expect(afterPost.transactionCount).toBe(2);
    expect(afterPost.snapshot.configRuleId).toBe(fixture.propertyCommissionRule.id);
    expect(afterPost.snapshot.commissionRateBps).toBe(2000);
    expect(afterPost.snapshot.commissionBasis).toBe("GROSS_ACCOMMODATION");
    expect(afterPost.balances.every((row) => new Decimal(row.balance).eq(0))).toBe(true);
    expect(
      afterPost.postings.find(
        (posting) => posting.ledgerAccount.code === "BANK_S6_REVENUE" && posting.side === "DEBIT"
      )?.amount.toString()
    ).toBe("8000");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.bucket === "OWNER_REVENUE" &&
          posting.side === "CREDIT"
      )?.amount.toString()
    ).toBe("8000");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.bucket === "COMMISSION" &&
          posting.side === "DEBIT"
      )?.amount.toString()
    ).toBe("1600");
    expect(
      afterPost.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "ALVILLAS_COMMISSION_REVENUE" &&
          posting.side === "CREDIT"
      )?.amount.toString()
    ).toBe("1600");

    const replay = await recordReservationAccommodationRevenue(ctx, recordInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-record-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(replay.idempotent).toBe(true);
    expect(transactionCountAfterReplay).toBe(2);
    await expect(
      recordReservationAccommodationRevenue(
        ctx,
        {
          ...recordInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-record-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueConflictError);

    const ownerCtx = await ownerPortalActorContextFromSession(
      sessionForOwnerPortal({
        organizationId: orgA.id,
        userAccountId: ownerUser.userAccountId,
        personId: ownerUser.personId,
        email: ownerUser.email
      }),
      {
        db: prisma as unknown as TenantTransactionRunner
      }
    );
    expect(ownerCtx).not.toBeNull();
    const postedStatement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2000-01-01", to: "2099-12-31" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-statement-posted",
        ipAddress: "127.0.0.1"
      }
    );

    expect(postedStatement.closingBalance.toJSON().amount).toBe("6400.00");

    await expect(
      recordReservationAccommodationRevenue(actorForOrganization(orgB.id, financePermissions), recordInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(ReservationRevenueNotFoundError);

    const reversalInput = {
      reservationId: reservation.reservation.id,
      reason: "Integration S6 reversal",
      idempotencyKey: randomUUID()
    };
    const reversed = await reverseReservationAccommodationRevenue(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-reversal",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReverse = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversed.idempotent).toBe(false);
    expect(reversed.reversalTransactionIds).toHaveLength(2);
    expect(transactionCountAfterReverse).toBe(4);
    const reversedStatement = await getOwnerStatement(
      ownerCtx!,
      fixture.property.id,
      { from: "2000-01-01", to: "2099-12-31" },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s6-statement-reversed",
        ipAddress: "127.0.0.1"
      }
    );

    expect(reversedStatement.closingBalance.toJSON().amount).toBe("0.00");

    const reversalReplay = await reverseReservationAccommodationRevenue(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s6-reversal-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReversalReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversalReplay.idempotent).toBe(true);
    expect(transactionCountAfterReversalReplay).toBe(4);
    await expect(
      reverseReservationAccommodationRevenue(
        ctx,
        {
          ...reversalInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s6-reversal-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueConflictError);
  });

  it("imports and reconciles Airbnb settlement CSV rows without duplicate postings", async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({
        data: { name: `ALVILLAS Airbnb Settlement A ${randomUUID()}`, baseCurrency: "MAD" }
      }),
      prisma.organization.create({
        data: { name: `ALVILLAS Airbnb Settlement B ${randomUUID()}`, baseCurrency: "MAD" }
      })
    ]);
    const financePermissions = new Set([
      permissionKey("reservation", "view"),
      permissionKey("reservation", "create"),
      permissionKey("task", "view"),
      permissionKey("task", "create"),
      permissionKey("financial_transaction", "view"),
      permissionKey("financial_transaction", "create"),
      permissionKey("financial_transaction", "void"),
      permissionKey("financial_transaction", "reconcile")
    ]);
    const externalId = `HM-${randomUUID()}`;
    const sourceTransactionId = `TX-${randomUUID()}`;
    const fixture = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => {
        const owner = await tx.owner.create({
          data: {
            organizationId: orgA.id,
            displayName: "S7 Airbnb Owner",
            email: `s7-airbnb-owner-${randomUUID()}@example.test`,
            preferredLocale: "en"
          }
        });
        const property = await tx.property.create({
          data: {
            organizationId: orgA.id,
            name: "Villa S7 Airbnb",
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
        const bank = await tx.ledgerAccount.create({
          data: {
            organizationId: orgA.id,
            code: "BANK_S7_AIRBNB",
            name: "S7 Airbnb settlement bank",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
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
                  checklist: []
                }
              ]
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: integrationActorId,
            reason: "S7 task templates"
          }
        });

        return { owner, property, bank };
      }
    );
    const ctx = actorForOrganization(orgA.id, financePermissions);
    const reservation = await createManualReservation(
      ctx,
      {
        propertyId: fixture.property.id,
        guestName: "S7 Airbnb Guest",
        guestEmail: "s7.airbnb.guest@example.test",
        source: "AIRBNB",
        externalId,
        checkIn: "2028-05-10",
        checkOut: "2028-05-14",
        adultCount: 2,
        childCount: 0,
        notes: "S7 Airbnb settlement reconciliation",
        idempotencyKey: randomUUID()
      },
      {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s7-reservation",
        ipAddress: "127.0.0.1"
      }
    );
    const csv = [
      "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action",
      `${externalId},PO-S7,${sourceTransactionId},MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout`
    ].join("\n");
    const importInput = {
      csv,
      receivedAccountId: fixture.bank.id,
      idempotencyKey: randomUUID()
    };

    await expect(
      importAirbnbSettlementCsv(
        actorForOrganization(
          orgA.id,
          new Set([
            permissionKey("reservation", "view"),
            permissionKey("financial_transaction", "view"),
            permissionKey("financial_transaction", "create")
          ])
        ),
        importInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);

    const imported = await importAirbnbSettlementCsv(ctx, importInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-import",
      ipAddress: "127.0.0.1"
    });
    const importedItem = imported.imported[0];

    expect(importedItem?.idempotent).toBe(false);
    expect(importedItem?.reservationId).toBe(reservation.reservation.id);
    expect(importedItem?.expectedPayout.toJSON().amount).toBe("5200.00");
    expect(importedItem?.actualReceipt.toJSON().amount).toBe("5150.00");
    expect(importedItem?.varianceAmount.toJSON().amount).toBe("50.00");
    expect(importedItem?.varianceId).not.toBeNull();
    const varianceId = importedItem.varianceId;
    if (!varianceId) {
      throw new Error("Expected Airbnb settlement import to create a variance");
    }

    const afterImport = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => ({
        transactionCount: await tx.financialTransaction.count({
          where: { organizationId: orgA.id }
        }),
        settlementCount: await tx.airbnbSettlement.count({
          where: { organizationId: orgA.id }
        }),
        varianceCount: await tx.variance.count({
          where: { organizationId: orgA.id, sourceType: "AIRBNB_SETTLEMENT" }
        }),
        postings: await tx.posting.findMany({
          where: {
            transactionId: {
              in: [importedItem.expectedTransactionId, importedItem.receiptTransactionId]
            }
          },
          include: {
            ledgerAccount: true
          }
        }),
        balances: await tx.$queryRaw<Array<{ transactionId: string; balance: string }>>`
          SELECT
            transaction_id AS "transactionId",
            sum(CASE WHEN side = 'DEBIT' THEN amount ELSE -amount END)::text AS balance
          FROM posting
          WHERE organization_id = ${orgA.id}::uuid
            AND transaction_id IN (${importedItem.expectedTransactionId}::uuid, ${importedItem.receiptTransactionId}::uuid)
          GROUP BY transaction_id
        `
      })
    );

    expect(afterImport.transactionCount).toBe(2);
    expect(afterImport.settlementCount).toBe(1);
    expect(afterImport.varianceCount).toBe(1);
    expect(afterImport.balances).toHaveLength(2);
    expect(afterImport.balances.every((row) => new Decimal(row.balance).eq(0))).toBe(true);
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OTA_CLEARING_AIRBNB" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_SETTLEMENT"
      )?.amount.toString()
    ).toBe("5200");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_FEE"
      )?.amount.toString()
    ).toBe("300");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "OWNER_PAYABLE" &&
          posting.side === "CREDIT" &&
          posting.bucket === "OWNER_REVENUE"
      )?.amount.toString()
    ).toBe("5500");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "BANK_S7_AIRBNB" &&
          posting.side === "DEBIT" &&
          posting.bucket === "OTA_RECEIPT"
      )?.amount.toString()
    ).toBe("5150");
    expect(
      afterImport.postings.find(
        (posting) =>
          posting.ledgerAccount.code === "VARIANCE_SUSPENSE" &&
          posting.side === "DEBIT" &&
          posting.bucket === "VARIANCE"
      )?.amount.toString()
    ).toBe("50");

    const variances = await listAirbnbSettlementVariances(ctx, {
      db: prisma as unknown as TenantTransactionRunner
    });
    expect(variances).toHaveLength(1);
    expect(variances[0]?.expectedAmount.toJSON().amount).toBe("5200.00");
    expect(variances[0]?.actualAmount.toJSON().amount).toBe("5150.00");
    expect(variances[0]?.varianceAmount.toJSON().amount).toBe("50.00");
    expect(variances[0]?.reason).toBe("Bank fee");
    expect(variances[0]?.action).toBe("Review payout");

    const replay = await importAirbnbSettlementCsv(ctx, importInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-import-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(replay.imported[0]?.idempotent).toBe(true);
    expect(transactionCountAfterReplay).toBe(2);
    await expect(
      importAirbnbSettlementCsv(
        ctx,
        {
          ...importInput,
          csv: csv.replace("5150.00", "5140.00"),
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-import-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementConflictError);

    await expect(
      importAirbnbSettlementCsv(actorForOrganization(orgB.id, financePermissions), importInput, {
        db: prisma as unknown as TenantTransactionRunner,
        requestId: "integration-s7-cross-tenant",
        ipAddress: "127.0.0.1"
      })
    ).rejects.toBeInstanceOf(AirbnbSettlementNotFoundError);

    const settlementVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.airbnbSettlement.findFirst({ where: { id: importedItem.settlementId } })
    );
    const varianceVisibleToOrgB = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgB.id,
      async (tx) => tx.variance.findFirst({ where: { id: varianceId } })
    );

    expect(settlementVisibleToOrgB).toBeNull();
    expect(varianceVisibleToOrgB).toBeNull();

    const reversalInput = {
      settlementId: importedItem.settlementId,
      reason: "Integration S7 reversal",
      idempotencyKey: randomUUID()
    };
    await expect(
      reverseAirbnbSettlement(
        actorForOrganization(
          orgA.id,
          new Set([
            permissionKey("financial_transaction", "view"),
            permissionKey("financial_transaction", "reconcile")
          ])
        ),
        reversalInput,
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-reversal-denied",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);

    const postingToMutate = afterImport.postings[0];
    await expect(
      withTenant(prisma as unknown as TenantTransactionRunner, orgA.id, async (tx) =>
        tx.posting.update({
          where: { id: postingToMutate.id },
          data: { amount: "1.00" }
        })
      )
    ).rejects.toThrow();

    const reversed = await reverseAirbnbSettlement(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-reversal",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReverse = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversed.idempotent).toBe(false);
    expect(reversed.reversalTransactionIds).toHaveLength(2);
    expect(transactionCountAfterReverse).toBe(4);

    const reversalReplay = await reverseAirbnbSettlement(ctx, reversalInput, {
      db: prisma as unknown as TenantTransactionRunner,
      requestId: "integration-s7-reversal-replay",
      ipAddress: "127.0.0.1"
    });
    const transactionCountAfterReversalReplay = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      orgA.id,
      async (tx) => tx.financialTransaction.count({ where: { organizationId: orgA.id } })
    );

    expect(reversalReplay.idempotent).toBe(true);
    expect(transactionCountAfterReversalReplay).toBe(4);
    await expect(
      reverseAirbnbSettlement(
        ctx,
        {
          ...reversalInput,
          idempotencyKey: randomUUID()
        },
        {
          db: prisma as unknown as TenantTransactionRunner,
          requestId: "integration-s7-reversal-conflict",
          ipAddress: "127.0.0.1"
        }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementConflictError);
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
