import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/platform/auth/password";
import { withTenant, type TenantTransactionRunner } from "../src/platform/db/tenant";
import { readEnv, type AppEnv } from "../src/platform/env/env";
import { bootstrapOrganizationId } from "../src/platform/identity/bootstrap";
import { ensureStandardIdentitySetup } from "../src/modules/identity/application/identity-service";
import { IdentityRepository } from "../src/modules/identity/infrastructure/identity-repository";
import { reservationTaskTemplatesConfigKey } from "../src/platform/config/rule-registry";

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

type BootstrapOptions = {
  timeoutMs?: number;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function bootstrapFirstAdmin(
  client: BootstrapClient,
  env: BootstrapEnv,
  options: BootstrapOptions = {}
): Promise<void> {
  if (!env.ADMIN_EMAIL) {
    throw new Error("ADMIN_EMAIL is required for first-admin bootstrap");
  }

  if (!env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD is required for first-admin bootstrap");
  }

  const email = normalizeEmail(env.ADMIN_EMAIL);
  const existing = await withTenant(client, bootstrapOrganizationId, (tx) =>
    new IdentityRepository(tx, bootstrapOrganizationId).findAccountIdByEmail(email));
  // Deployment bootstrap creates the first account; recovery and account lifecycle
  // own all subsequent changes. Repeated deployments must preserve enrolled factors.
  if (existing) return;
  const organization = await client.organization.upsert({
    where: { id: bootstrapOrganizationId },
    update: { name: "ALVILLAS SARL", baseCurrency: "MAD" },
    create: { id: bootstrapOrganizationId, name: "ALVILLAS SARL", baseCurrency: "MAD" }
  });
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  await withTenant(client, organization.id, async (tx) => {
    const bootstrapRepository = new IdentityRepository(tx, organization.id);
    await bootstrapRepository.lockIdentityOperation(`first-admin:${email}`);
    if (await bootstrapRepository.findAccountIdByEmail(email)) return;
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

    const account = await tx.userAccount.upsert({
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

    const existingPasswordCredential = await tx.authCredential.findFirst({
      where: {
        organizationId: organization.id,
        userAccountId: account.id,
        type: "PASSWORD",
        revokedAt: null
      }
    });

    if (existingPasswordCredential) {
      await tx.authCredential.update({
        where: { id: existingPasswordCredential.id },
        data: {
          secretHash: passwordHash,
          label: "Password"
        }
      });
    } else {
      await tx.authCredential.create({
        data: {
          organizationId: organization.id,
          userAccountId: account.id,
          type: "PASSWORD",
          label: "Password",
          secretHash: passwordHash
        }
      });
    }

    await ensureStandardIdentitySetup(organization.id, {
      db: { $transaction: (callback) => callback(tx) }
    });

    const identityRepository = new IdentityRepository(tx, organization.id);
    const adminRole = await identityRepository.findRoleByKey("admin");

    if (adminRole) {
      await identityRepository.assignRole({
        personId: person.id,
        userAccountId: account.id,
        roleId: adminRole.id,
        scopeType: "organization",
        actorId: account.id
      });
    }

    const existingReservationTaskConfig = await tx.configRule.findFirst({
      where: {
        organizationId: organization.id,
        key: reservationTaskTemplatesConfigKey,
        scopeType: "organization",
        scopeId: null,
        archivedAt: null
      }
    });

    if (!existingReservationTaskConfig) {
      await tx.configRule.create({
        data: {
          organizationId: organization.id,
          key: reservationTaskTemplatesConfigKey,
          scopeType: "organization",
          scopeId: null,
          value: {
            tasks: [
              {
                key: "arrival",
                type: "ARRIVAL_PREPARATION",
                title: {
                  en: "Arrival preparation",
                  fr: "Preparation arrivee",
                  ar: "Arrival preparation"
                },
                due: "CHECK_IN",
                priority: "NORMAL",
                checklist: [
                  {
                    key: "bedrooms",
                    label: {
                      en: "Bedrooms ready",
                      fr: "Chambres pretes",
                      ar: "Bedrooms ready"
                    }
                  },
                  {
                    key: "bathrooms",
                    label: {
                      en: "Bathrooms ready",
                      fr: "Salles de bain pretes",
                      ar: "Bathrooms ready"
                    }
                  },
                  {
                    key: "supplies",
                    label: {
                      en: "Guest supplies placed",
                      fr: "Fournitures voyageurs en place",
                      ar: "Guest supplies placed"
                    }
                  }
                ]
              },
              {
                key: "checkout",
                type: "CHECKOUT_CLEANING",
                title: {
                  en: "Checkout cleaning",
                  fr: "Menage depart",
                  ar: "Checkout cleaning"
                },
                due: "CHECK_OUT",
                priority: "NORMAL",
                checklist: [
                  {
                    key: "linen",
                    label: {
                      en: "Linen collected",
                      fr: "Linge collecte",
                      ar: "Linen collected"
                    }
                  },
                  {
                    key: "cleaning",
                    label: {
                      en: "Cleaning completed",
                      fr: "Menage termine",
                      ar: "Cleaning completed"
                    }
                  },
                  {
                    key: "inspection",
                    label: {
                      en: "Damage check completed",
                      fr: "Controle dommages termine",
                      ar: "Damage check completed"
                    }
                  }
                ]
              }
            ]
          },
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          version: 1,
          createdBy: account.id,
          reason: "Bootstrap standard reservation task templates"
        }
      });
    }
  }, { timeout: options.timeoutMs ?? 120000 });
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
