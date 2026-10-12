import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { standardRoles } from "@/modules/identity/domain/identity";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

export function e2eEmail(label: string, projectName: string): string {
  return `e2e-${label}-${projectName}@example.test`
    .toLowerCase()
    .replace(/[^a-z0-9@.-]+/gu, "-");
}

export async function ensureE2EAdmin(email: string, password: string): Promise<void> {
  const prisma = new PrismaClient();
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  try {
    await prisma.organization.upsert({
      where: { id: bootstrapOrganizationId },
      update: { name: "ALVILLAS SARL", baseCurrency: "MAD" },
      create: { id: bootstrapOrganizationId, name: "ALVILLAS SARL", baseCurrency: "MAD" }
    });

    await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      const person = await tx.person.upsert({
      where: {
        organizationId_email: {
          organizationId: bootstrapOrganizationId,
          email: normalizedEmail
        }
      },
      update: {
        displayName: "ALVILLAS E2E Admin",
        preferredLocale: "en"
      },
      create: {
        organizationId: bootstrapOrganizationId,
        displayName: "ALVILLAS E2E Admin",
        email: normalizedEmail,
        preferredLocale: "en"
      }
    });

      await tx.userAccount.upsert({
      where: {
        organizationId_email: {
          organizationId: bootstrapOrganizationId,
          email: normalizedEmail
        }
      },
      update: {
        personId: person.id,
        passwordHash,
        status: "ACTIVE"
      },
      create: {
        organizationId: bootstrapOrganizationId,
        personId: person.id,
        email: normalizedEmail,
        passwordHash,
        status: "ACTIVE"
      }
    });

      const account = await tx.userAccount.findUniqueOrThrow({
      where: {
        organizationId_email: {
          organizationId: bootstrapOrganizationId,
          email: normalizedEmail
        }
      }
    });
      const existingPasswordCredential = await tx.authCredential.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSWORD",
        revokedAt: null
      }
    });

    if (existingPasswordCredential) {
        await tx.authCredential.update({
        where: { id: existingPasswordCredential.id },
        data: { secretHash: passwordHash }
      });
    } else {
        await tx.authCredential.create({
        data: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: "PASSWORD",
          label: "Password",
          secretHash: passwordHash
        }
      });
    }

      const repository = new IdentityRepository(tx, bootstrapOrganizationId);

    for (const role of standardRoles) {
      await repository.ensureRole({
        key: role.key,
        name: role.name,
        permissions: role.permissions,
        isSystem: true
      });
    }

    const adminRole = await repository.findRoleByKey("admin");

    if (adminRole) {
      await repository.assignRole({
        personId: person.id,
        userAccountId: account.id,
        roleId: adminRole.id,
        scopeType: "organization",
        actorId: account.id
      });
    }
    });
  } finally {
    await prisma.$disconnect();
  }
}
