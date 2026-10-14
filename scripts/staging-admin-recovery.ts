import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { bootstrapFirstAdmin } from "../prisma/bootstrap-admin";
import { writeAuditEvent } from "../src/platform/audit/audit-writer";
import { withTenant, type TenantTransactionRunner } from "../src/platform/db/tenant";
import { bootstrapOrganizationId } from "../src/platform/identity/bootstrap";

const adminEmail = (process.env.STAGING_ADMIN_EMAIL ?? "admin.staging@alvillas.test")
  .trim()
  .toLowerCase();

type AdminSnapshot = {
  id: string;
  email: string | null;
  status: string;
  sessionVersion: number;
  mfaRequired: boolean;
  lastLoginAt: Date | null;
  person: {
    id: string;
    displayName: string;
    preferredLocale: string;
  };
  activeCredentialTypes: string[];
  roleAssignments: Array<{
    roleKey: string;
    scopeType: string;
    scopeId: string | null;
  }>;
  activeSessions: number;
};

function command(): string {
  return process.argv[2] ?? "inspect";
}

function stagingEnvironmentSummary(): Record<string, unknown> {
  return {
    vercelProjectId: process.env.VERCEL_PROJECT_ID ?? "prj_GJBdVD7r7fBkG7vH9rn2K2eLwobC",
    vercelTeamId: process.env.VERCEL_ORG_ID ?? "team_tVCdcmsKYxqXHGybrNlB0CGS",
    neonProjectId: process.env.NEON_PROJECT_ID ?? null,
    database: process.env.PGDATABASE ?? process.env.POSTGRES_DATABASE ?? null,
    host: process.env.PGHOST ?? process.env.POSTGRES_HOST ?? null,
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
    directUrlConfigured: Boolean(
      process.env.DIRECT_DATABASE_URL ??
        process.env.DATABASE_URL_UNPOOLED ??
        process.env.POSTGRES_URL_NON_POOLING
    )
  };
}

async function migrationSummary(prisma: PrismaClient): Promise<Record<string, unknown>> {
  const migrations = await prisma.$queryRaw<
    Array<{ migration_name: string; finished_at: Date | null }>
  >`SELECT migration_name, finished_at
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL
    ORDER BY finished_at ASC`;

  return {
    applied: migrations.length,
    latest: migrations.at(-1) ?? null
  };
}

async function inspectAdmin(prisma: PrismaClient): Promise<{
  admin: AdminSnapshot | null;
  counts: Record<string, number>;
}> {
  return withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
    const admin = await tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        email: adminEmail
      },
      select: {
        id: true,
        email: true,
        status: true,
        sessionVersion: true,
        mfaRequired: true,
        lastLoginAt: true,
        person: {
          select: {
            id: true,
            displayName: true,
            preferredLocale: true
          }
        },
        authCredentials: {
          where: { revokedAt: null },
          select: { type: true }
        },
        roleAssignments: {
          where: { archivedAt: null, validTo: null },
          select: {
            scopeType: true,
            scopeId: true,
            role: {
              select: {
                key: true
              }
            }
          }
        }
      }
    });

    const activeSessions = admin
      ? await tx.authSession.count({
          where: {
            organizationId: bootstrapOrganizationId,
            userAccountId: admin.id,
            revokedAt: null,
            expiresAt: { gt: new Date() }
          }
        })
      : 0;

    const counts = {
      organizations: await tx.organization.count({ where: { id: bootstrapOrganizationId } }),
      people: await tx.person.count({ where: { organizationId: bootstrapOrganizationId } }),
      userAccounts: await tx.userAccount.count({ where: { organizationId: bootstrapOrganizationId } }),
      roles: await tx.role.count({ where: { organizationId: bootstrapOrganizationId } }),
      roleAssignments: await tx.roleAssignment.count({
        where: { organizationId: bootstrapOrganizationId, archivedAt: null }
      }),
      owners: await tx.owner.count({ where: { organizationId: bootstrapOrganizationId } }),
      properties: await tx.property.count({ where: { organizationId: bootstrapOrganizationId } }),
      reservations: await tx.reservation.count({ where: { organizationId: bootstrapOrganizationId } }),
      operationTasks: await tx.operationTask.count({ where: { organizationId: bootstrapOrganizationId } }),
      ledgerAccounts: await tx.ledgerAccount.count({ where: { organizationId: bootstrapOrganizationId } }),
      financialTransactions: await tx.financialTransaction.count({
        where: { organizationId: bootstrapOrganizationId }
      }),
      configRules: await tx.configRule.count({ where: { organizationId: bootstrapOrganizationId } }),
      activeAdminSessions: activeSessions
    };

    return {
      admin: admin
        ? {
            id: admin.id,
            email: admin.email,
            status: admin.status,
            sessionVersion: admin.sessionVersion,
            mfaRequired: admin.mfaRequired,
            lastLoginAt: admin.lastLoginAt,
            person: admin.person,
            activeCredentialTypes: admin.authCredentials.map((credential) => credential.type).sort(),
            roleAssignments: admin.roleAssignments.map((assignment) => ({
              roleKey: assignment.role.key,
              scopeType: assignment.scopeType,
              scopeId: assignment.scopeId
            })),
            activeSessions
          }
        : null,
      counts
    };
  });
}

async function resetAdmin(prisma: PrismaClient): Promise<Record<string, unknown>> {
  const passwordFile = process.env.STAGING_ADMIN_PASSWORD_FILE;

  if (!passwordFile) {
    throw new Error("STAGING_ADMIN_PASSWORD_FILE is required");
  }

  const password = (await readFile(passwordFile, "utf8")).trimEnd();
  const before = await inspectAdmin(prisma);

  await bootstrapFirstAdmin(prisma, {
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: password
  });

  await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: { organizationId: bootstrapOrganizationId, email: adminEmail },
      select: {
        id: true,
        status: true,
        sessionVersion: true
      }
    });

    if (!account) {
      throw new Error(`Staging admin ${adminEmail} was not found after bootstrap`);
    }

    const revokedAt = new Date();
    const revokedSessions = await tx.authSession.updateMany({
      where: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        revokedAt: null
      },
      data: { revokedAt }
    });

    const updatedAccount = await tx.userAccount.update({
      where: { id: account.id },
      data: {
        sessionVersion: { increment: 1 }
      },
      select: {
        status: true,
        sessionVersion: true,
        mfaRequired: true
      }
    });

    await writeAuditEvent(tx, {
      organizationId: bootstrapOrganizationId,
      actorId: account.id,
      action: "identity.account.recover",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress: null,
      deviceId: null,
      propertyScopeId: null,
      before: {
        status: account.status,
        sessionVersion: account.sessionVersion
      },
      after: {
        status: updatedAccount.status,
        sessionVersion: updatedAccount.sessionVersion,
        mfaRequired: updatedAccount.mfaRequired,
        passwordRotated: true,
        sessionsRevoked: revokedSessions.count,
        passwordRotationRequired: "unsupported_by_current_schema"
      },
      reason: "Owner-authorized staging admin recovery",
      requestId: `staging-admin-recovery-${randomUUID()}`,
      occurredAt: revokedAt
    });
  });

  const after = await inspectAdmin(prisma);

  return {
    before,
    after,
    passwordRotationRequired: "unsupported_by_current_schema"
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const action = command();
    const output =
      action === "inspect"
        ? {
            environment: stagingEnvironmentSummary(),
            migrations: await migrationSummary(prisma),
            state: await inspectAdmin(prisma)
          }
        : action === "reset-admin"
          ? {
              environment: stagingEnvironmentSummary(),
              result: await resetAdmin(prisma)
            }
          : null;

    if (!output) {
      throw new Error(`Unknown command: ${action}`);
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

await main();
