import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";

function ledgerCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/gu, "").slice(0, 18)}`.toUpperCase();
}

export async function ensureReservationRevenuePostingSetup(input: {
  ownerEmail: string;
  propertyName: string;
  password: string;
  commissionRateBps?: number | null;
}): Promise<{
  ownerEmail: string;
  propertyId: string;
  bankName: string;
}> {
  const prisma = new PrismaClient();
  const passwordHash = await hashPassword(input.password);
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const bankName = `S6 revenue bank ${randomUUID().slice(0, 8)}`;
  const commissionRateBps = input.commissionRateBps === undefined ? 2000 : input.commissionRateBps;

  try {
    return await prisma.$transaction(async (tx) => {
      const owner = await tx.owner.findUniqueOrThrow({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: ownerEmail
          }
        }
      });
      const property = await tx.property.findFirstOrThrow({
        where: {
          organizationId: bootstrapOrganizationId,
          name: input.propertyName,
          propertyOwners: {
            some: {
              ownerId: owner.id,
              archivedAt: null
            }
          }
        }
      });
      const person = await tx.person.upsert({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: ownerEmail
          }
        },
        update: {
          displayName: owner.displayName,
          preferredLocale: "en"
        },
        create: {
          organizationId: bootstrapOrganizationId,
          displayName: owner.displayName,
          email: ownerEmail,
          preferredLocale: "en"
        }
      });
      const userAccount = await tx.userAccount.upsert({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: ownerEmail
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
          email: ownerEmail,
          passwordHash,
          status: "ACTIVE"
        }
      });

      await tx.ownerPortalAccess.upsert({
        where: {
          organizationId_ownerId_userAccountId: {
            organizationId: bootstrapOrganizationId,
            ownerId: owner.id,
            userAccountId: userAccount.id
          }
        },
        update: {
          archivedAt: null
        },
        create: {
          organizationId: bootstrapOrganizationId,
          ownerId: owner.id,
          userAccountId: userAccount.id
        }
      });

      await tx.ledgerAccount.create({
        data: {
          organizationId: bootstrapOrganizationId,
          code: ledgerCode("BANK_S6"),
          name: bankName,
          accountType: "ASSET_LOCATION",
          normalSide: "DEBIT"
        }
      });
      if (commissionRateBps !== null) {
        await tx.configRule.create({
          data: {
            organizationId: bootstrapOrganizationId,
            key: "finance.commission",
            scopeType: "property",
            scopeId: property.id,
            value: {
              rate_bps: commissionRateBps,
              basis: "GROSS_ACCOMMODATION",
              accrual_event: "ON_RECEIPT"
            },
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            version: 1,
            createdBy: userAccount.id,
            reason: "S6 E2E commission rule"
          }
        });
      }

      return {
        ownerEmail,
        propertyId: property.id,
        bankName
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}
