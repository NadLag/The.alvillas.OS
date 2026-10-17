import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { withTenant, type TenantTransactionRunner } from "../src/platform/db/tenant";

export const demoOrganizationId = "018f0a0b-0000-7000-9000-000000000100";
export const demoOwnerId = "018f0a0b-0000-7000-9000-000000000101";
export const demoPropertyId = "018f0a0b-0000-7000-9000-000000000102";
export const demoReservationId = "018f0a0b-0000-7000-9000-000000000103";
export const demoTaskId = "018f0a0b-0000-7000-9000-000000000104";
export const demoTransactionId = "018f0a0b-0000-7000-9000-000000000105";

type DemoSeedClient = TenantTransactionRunner & {
  organization: {
    upsert(args: {
      where: { id: string };
      update: { name: string; baseCurrency: string };
      create: { id: string; name: string; baseCurrency: string };
    }): Promise<unknown>;
  };
};

export type DemoSeedSummary = {
  organizationId: string;
  owners: number;
  properties: number;
  reservations: number;
  tasks: number;
  ledgerTransactions: number;
  localizedPaths: number;
};

export function assertDemoSeedAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    throw new Error("Demo seed cannot run in production");
  }
}

export async function seedDemoData(client: DemoSeedClient): Promise<DemoSeedSummary> {
  await client.organization.upsert({
    where: { id: demoOrganizationId },
    update: {
      name: "ALVILLAS Demo",
      baseCurrency: "MAD"
    },
    create: {
      id: demoOrganizationId,
      name: "ALVILLAS Demo",
      baseCurrency: "MAD"
    }
  });

  return withTenant(client, demoOrganizationId, async (tx) => {
    const owner = await tx.owner.upsert({
      where: { id: demoOwnerId },
      update: {
        displayName: "Demo Owner",
        legalName: "Demo Owner SARL",
        email: "owner.demo@alvillas.test",
        phone: "+212600000101",
        preferredLocale: "fr",
        notes: "Deterministic demo owner"
      },
      create: {
        id: demoOwnerId,
        organizationId: demoOrganizationId,
        displayName: "Demo Owner",
        legalName: "Demo Owner SARL",
        email: "owner.demo@alvillas.test",
        phone: "+212600000101",
        preferredLocale: "fr",
        notes: "Deterministic demo owner"
      }
    });
    const property = await tx.property.upsert({
      where: { id: demoPropertyId },
      update: {
        name: "Villa Demo Palmeraie",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        region: "Marrakech-Safi",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden", "wifi", "chef-ready"],
        photoUrls: [],
        status: "ACTIVE"
      },
      create: {
        id: demoPropertyId,
        organizationId: demoOrganizationId,
        name: "Villa Demo Palmeraie",
        addressLine1: "Route de Fes",
        city: "Marrakech",
        region: "Marrakech-Safi",
        countryCode: "MA",
        propertyType: "Villa",
        bedrooms: 5,
        bathrooms: 5,
        livingSpaces: 2,
        hasPool: true,
        hasGarden: true,
        parkingSpaces: 2,
        maxGuests: 10,
        timezone: "Africa/Casablanca",
        amenities: ["pool", "garden", "wifi", "chef-ready"],
        photoUrls: [],
        status: "ACTIVE"
      }
    });

    await tx.propertyOwner.upsert({
      where: {
        organizationId_propertyId_ownerId: {
          organizationId: demoOrganizationId,
          propertyId: property.id,
          ownerId: owner.id
        }
      },
      update: {
        shareBps: 10000,
        isPrimary: true
      },
      create: {
        organizationId: demoOrganizationId,
        propertyId: property.id,
        ownerId: owner.id,
        shareBps: 10000,
        isPrimary: true
      }
    });

    const reservation = await tx.reservation.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: demoOrganizationId,
          idempotencyKey: "demo-reservation-palmeraie-2026-11-01"
        }
      },
      update: {
        propertyId: property.id,
        reference: "DEMO-RES-0001",
        source: "DIRECT",
        status: "CONFIRMED",
        guestName: "Demo Guest",
        guestEmail: "guest.demo@alvillas.test",
        checkIn: new Date("2026-11-01T00:00:00.000Z"),
        checkOut: new Date("2026-11-06T00:00:00.000Z"),
        nights: 5,
        adultCount: 4,
        childCount: 2,
        notes: "Deterministic demo reservation"
      },
      create: {
        id: demoReservationId,
        organizationId: demoOrganizationId,
        propertyId: property.id,
        reference: "DEMO-RES-0001",
        source: "DIRECT",
        status: "CONFIRMED",
        guestName: "Demo Guest",
        guestEmail: "guest.demo@alvillas.test",
        checkIn: new Date("2026-11-01T00:00:00.000Z"),
        checkOut: new Date("2026-11-06T00:00:00.000Z"),
        nights: 5,
        adultCount: 4,
        childCount: 2,
        notes: "Deterministic demo reservation",
        idempotencyKey: "demo-reservation-palmeraie-2026-11-01"
      }
    });
    const task = await tx.operationTask.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: demoOrganizationId,
          idempotencyKey: "demo-task-arrival-palmeraie-2026-11-01"
        }
      },
      update: {
        propertyId: property.id,
        reservationId: reservation.id,
        type: "ARRIVAL_PREPARATION",
        state: "PLANNED",
        priority: "HIGH",
        dueDate: new Date("2026-11-01T00:00:00.000Z"),
        titleTranslations: {
          en: "Demo arrival preparation",
          fr: "Preparation arrivee demo"
        }
      },
      create: {
        id: demoTaskId,
        organizationId: demoOrganizationId,
        propertyId: property.id,
        reservationId: reservation.id,
        type: "ARRIVAL_PREPARATION",
        state: "PLANNED",
        priority: "HIGH",
        dueDate: new Date("2026-11-01T00:00:00.000Z"),
        titleTranslations: {
          en: "Demo arrival preparation",
          fr: "Preparation arrivee demo"
        },
        idempotencyKey: "demo-task-arrival-palmeraie-2026-11-01"
      }
    });

    for (const item of [
      { key: "linen", sortOrder: 1, labelTranslations: { en: "Linen ready", fr: "Linge pret" } },
      { key: "welcome", sortOrder: 2, labelTranslations: { en: "Welcome set placed", fr: "Accueil en place" } }
    ]) {
      await tx.operationTaskChecklistItem.upsert({
        where: {
          organizationId_taskId_key: {
            organizationId: demoOrganizationId,
            taskId: task.id,
            key: item.key
          }
        },
        update: {
          labelTranslations: item.labelTranslations,
          sortOrder: item.sortOrder
        },
        create: {
          organizationId: demoOrganizationId,
          taskId: task.id,
          key: item.key,
          labelTranslations: item.labelTranslations,
          sortOrder: item.sortOrder
        }
      });
    }

    const bank = await tx.ledgerAccount.upsert({
      where: { organizationId_code: { organizationId: demoOrganizationId, code: "DEMO_BANK" } },
      update: { name: "Demo bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" },
      create: {
        organizationId: demoOrganizationId,
        code: "DEMO_BANK",
        name: "Demo bank",
        accountType: "ASSET_LOCATION",
        normalSide: "DEBIT"
      }
    });
    const ownerPayable = await tx.ledgerAccount.upsert({
      where: { organizationId_code: { organizationId: demoOrganizationId, code: "OWNER_PAYABLE" } },
      update: { name: "Owner payable", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" },
      create: {
        organizationId: demoOrganizationId,
        code: "OWNER_PAYABLE",
        name: "Owner payable",
        accountType: "CLAIM_OWNERSHIP",
        normalSide: "CREDIT"
      }
    });

    await tx.financialTransaction.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: demoOrganizationId,
          idempotencyKey: "demo-owner-opening-balance"
        }
      },
      update: {
        description: "Demo owner opening balance"
      },
      create: {
        id: demoTransactionId,
        organizationId: demoOrganizationId,
        reference: "DEMO-TX-0001",
        occurredAt: new Date("2026-10-01T00:00:00.000Z"),
        description: "Demo owner opening balance",
        idempotencyKey: "demo-owner-opening-balance",
        postings: {
          create: [
            {
              organizationId: demoOrganizationId,
              ledgerAccountId: bank.id,
              side: "DEBIT",
              amount: "25000.00",
              currency: "MAD",
              bucket: "OWNER_REVENUE"
            },
            {
              organizationId: demoOrganizationId,
              ledgerAccountId: ownerPayable.id,
              side: "CREDIT",
              amount: "25000.00",
              currency: "MAD",
              bucket: "OWNER_REVENUE"
            }
          ]
        }
      }
    });

    const localizedPaths = {
      paths: [
        { key: "owners", en: "/en/app/owners", fr: "/fr/app/owners" },
        { key: "properties", en: "/en/app/properties", fr: "/fr/app/properties" },
        { key: "reservations", en: "/en/app/reservations", fr: "/fr/app/reservations" },
        { key: "operations", en: "/en/app/operations", fr: "/fr/app/operations" },
        { key: "templates", en: "/en/app/templates", fr: "/fr/app/templates" }
      ]
    };
    const existingPathRule = await tx.configRule.findFirst({
      where: {
        organizationId: demoOrganizationId,
        key: "demo.localized_paths",
        scopeType: "organization",
        scopeId: null,
        archivedAt: null
      }
    });

    if (existingPathRule) {
      await tx.configRule.update({
        where: { id: existingPathRule.id },
        data: {
          value: localizedPaths,
          reason: "Refresh deterministic demo EN/FR paths"
        }
      });
    } else {
      await tx.configRule.create({
        data: {
          organizationId: demoOrganizationId,
          key: "demo.localized_paths",
          scopeType: "organization",
          scopeId: null,
          value: localizedPaths,
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          version: 1,
          reason: "Seed deterministic demo EN/FR paths"
        }
      });
    }

    return {
      organizationId: demoOrganizationId,
      owners: await tx.owner.count({ where: { organizationId: demoOrganizationId } }),
      properties: await tx.property.count({ where: { organizationId: demoOrganizationId } }),
      reservations: await tx.reservation.count({ where: { organizationId: demoOrganizationId } }),
      tasks: await tx.operationTask.count({ where: { organizationId: demoOrganizationId } }),
      ledgerTransactions: await tx.financialTransaction.count({
        where: { organizationId: demoOrganizationId }
      }),
      localizedPaths: localizedPaths.paths.length
    };
  });
}

async function main(): Promise<void> {
  assertDemoSeedAllowed();
  const prisma = new PrismaClient();

  try {
    await seedDemoData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
