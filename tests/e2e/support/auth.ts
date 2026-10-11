import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";

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
    const person = await prisma.person.upsert({
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

    await prisma.userAccount.upsert({
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
  } finally {
    await prisma.$disconnect();
  }
}
