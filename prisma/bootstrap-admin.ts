import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/platform/auth/password";
import { withTenant, type TenantTransactionRunner } from "../src/platform/db/tenant";
import { readEnv, type AppEnv } from "../src/platform/env/env";
import { bootstrapOrganizationId } from "../src/platform/identity/bootstrap";

export { bootstrapOrganizationId };

type BootstrapClient = TenantTransactionRunner & {
  organization: {
    upsert(args: {
      where: { id: string };
      update: { name: string; baseCurrency: string };
      create: { id: string; name: string; baseCurrency: string };
    }): Promise<{ id: string }>;
  };
};

type BootstrapEnv = Pick<AppEnv, "ADMIN_EMAIL" | "ADMIN_PASSWORD">;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function bootstrapFirstAdmin(
  client: BootstrapClient,
  env: BootstrapEnv
): Promise<void> {
  if (!env.ADMIN_EMAIL) {
    throw new Error("ADMIN_EMAIL is required for first-admin bootstrap");
  }

  if (!env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD is required for first-admin bootstrap");
  }

  const email = normalizeEmail(env.ADMIN_EMAIL);
  const organization = await client.organization.upsert({
    where: { id: bootstrapOrganizationId },
    update: { name: "ALVILLAS SARL", baseCurrency: "MAD" },
    create: { id: bootstrapOrganizationId, name: "ALVILLAS SARL", baseCurrency: "MAD" }
  });
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  await withTenant(client, organization.id, async (tx) => {
    const person = await tx.person.upsert({
      where: { organizationId_email: { organizationId: organization.id, email } },
      update: {
        displayName: "ALVILLAS Admin",
        preferredLocale: "en"
      },
      create: {
        organizationId: organization.id,
        displayName: "ALVILLAS Admin",
        email,
        preferredLocale: "en"
      }
    });

    await tx.userAccount.upsert({
      where: { organizationId_email: { organizationId: organization.id, email } },
      update: {
        personId: person.id,
        passwordHash,
        status: "ACTIVE"
      },
      create: {
        organizationId: organization.id,
        personId: person.id,
        email,
        passwordHash,
        status: "ACTIVE"
      }
    });
  });
}

async function main(): Promise<void> {
  const env = readEnv();
  const prisma = new PrismaClient();

  try {
    await bootstrapFirstAdmin(prisma, env);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
