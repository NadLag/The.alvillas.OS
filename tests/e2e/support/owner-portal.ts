import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import {
  addUtcDays,
  dateOnlyToUtc,
  defaultStatementPeriod
} from "@/modules/owner-portal/domain/owner-statement";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";

type OwnerPortalScenario = {
  ownerEmail: string;
  tenantEmail: string;
  ownerId: string;
  propertyId: string;
  propertyName: string;
  otherPropertyId: string;
  otherPropertyName: string;
  period: { from: string; to: string };
  bankCode: string;
};

type OwnerStatementTotals = {
  opening: string;
  credits: string;
  debits: string;
  closing: string;
};

function ledgerCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/gu, "").slice(0, 18)}`.toUpperCase();
}

function signedAmount(row: { side: string; amount: string }): Decimal {
  const amount = new Decimal(row.amount);
  return row.side === "CREDIT" ? amount : amount.negated();
}

export async function ensureOwnerPortalScenario(input: {
  suffix: string;
  password: string;
}): Promise<OwnerPortalScenario> {
  const prisma = new PrismaClient();
  const passwordHash = await hashPassword(input.password);
  const period = defaultStatementPeriod();
  const periodStart = dateOnlyToUtc(period.from);
  let openingDate = addUtcDays(periodStart, -2);
  const revenueDate = addUtcDays(periodStart, 1);
  const serviceDate = addUtcDays(periodStart, 2);
  const commissionDate = addUtcDays(periodStart, 3);
  const expenseDate = addUtcDays(periodStart, 4);
  const payoutDate = addUtcDays(periodStart, 5);
  const ownerEmail = `owner-portal-${input.suffix}@example.test`;
  const tenantEmail = `owner-portal-tenant-${input.suffix}@example.test`;
  const otherOwnerEmail = `owner-portal-other-${input.suffix}@example.test`;
  const propertyName = `Owner Ledger Villa ${input.suffix}`;
  const otherPropertyName = `Other Owner Villa ${input.suffix}`;
  const bankCode = ledgerCode("BANK_E2E");
  const commissionCode = ledgerCode("ALVILLAS_COMMISSION");

  try {
    return await prisma.$transaction(async (tx) => {
      const periods = new AccountingPeriodRepository(tx, bootstrapOrganizationId);
      while (!await periods.postingOpen(openingDate)) {
        const closed = await periods.postingPeriod(openingDate);
        const historical = closed ? await periods.period(closed.id) : null;
        if (!historical) throw new Error("Owner statement fixture requires an open historical period");
        openingDate = addUtcDays(historical.startsAt, -1);
      }
      const ownerPerson = await tx.person.create({
        data: {
          organizationId: bootstrapOrganizationId,
          displayName: "Owner Portal E2E",
          email: ownerEmail,
          preferredLocale: "en"
        }
      });
      const ownerAccount = await tx.userAccount.create({
        data: {
          organizationId: bootstrapOrganizationId,
          personId: ownerPerson.id,
          email: ownerEmail,
          passwordHash,
          status: "ACTIVE"
        }
      });
      const tenantPerson = await tx.person.create({
        data: {
          organizationId: bootstrapOrganizationId,
          displayName: "Owner Portal Tenant E2E",
          email: tenantEmail,
          preferredLocale: "en"
        }
      });
      await tx.userAccount.create({
        data: {
          organizationId: bootstrapOrganizationId,
          personId: tenantPerson.id,
          email: tenantEmail,
          passwordHash,
          status: "ACTIVE"
        }
      });
      const otherOwnerPerson = await tx.person.create({
        data: {
          organizationId: bootstrapOrganizationId,
          displayName: "Other Owner Portal E2E",
          email: otherOwnerEmail,
          preferredLocale: "en"
        }
      });
      const otherOwnerAccount = await tx.userAccount.create({
        data: {
          organizationId: bootstrapOrganizationId,
          personId: otherOwnerPerson.id,
          email: otherOwnerEmail,
          passwordHash,
          status: "ACTIVE"
        }
      });
      const [owner, otherOwner] = await Promise.all([
        tx.owner.create({
          data: {
            organizationId: bootstrapOrganizationId,
            displayName: `Owner Portal Owner ${input.suffix}`,
            email: ownerEmail,
            preferredLocale: "en"
          }
        }),
        tx.owner.create({
          data: {
            organizationId: bootstrapOrganizationId,
            displayName: `Other Owner ${input.suffix}`,
            email: otherOwnerEmail,
            preferredLocale: "en"
          }
        })
      ]);
      const [property, otherProperty] = await Promise.all([
        tx.property.create({
          data: {
            organizationId: bootstrapOrganizationId,
            name: propertyName,
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
                organizationId: bootstrapOrganizationId,
                ownerId: owner.id,
                shareBps: 10000,
                isPrimary: true
              }
            }
          }
        }),
        tx.property.create({
          data: {
            organizationId: bootstrapOrganizationId,
            name: otherPropertyName,
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
                organizationId: bootstrapOrganizationId,
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
            organizationId: bootstrapOrganizationId,
            ownerId: owner.id,
            userAccountId: ownerAccount.id
          }
        }),
        tx.ownerPortalAccess.create({
          data: {
            organizationId: bootstrapOrganizationId,
            ownerId: otherOwner.id,
            userAccountId: otherOwnerAccount.id
          }
        })
      ]);
      await tx.ledgerAccount.createMany({
        data: [
          {
            organizationId: bootstrapOrganizationId,
            code: "OWNER_PAYABLE",
            name: "Owner payable",
            accountType: "CLAIM_OWNERSHIP",
            normalSide: "CREDIT"
          }
        ],
        skipDuplicates: true
      });
      const ownerPayable = await tx.ledgerAccount.findUniqueOrThrow({
        where: {
          organizationId_code: {
            organizationId: bootstrapOrganizationId,
            code: "OWNER_PAYABLE"
          }
        }
      });
      const [bank, commissionRevenue] = await Promise.all([
        tx.ledgerAccount.create({
          data: {
            organizationId: bootstrapOrganizationId,
            code: bankCode,
            name: "Operating bank",
            accountType: "ASSET_LOCATION",
            normalSide: "DEBIT"
          }
        }),
        tx.ledgerAccount.create({
          data: {
            organizationId: bootstrapOrganizationId,
            code: commissionCode,
            name: "ALVILLAS commission revenue",
            accountType: "ALVILLAS_OWN",
            normalSide: "CREDIT"
          }
        })
      ]);
      const dimensions = {
        owner_id: owner.id,
        property_id: property.id,
        reservation_reference: `RES-${input.suffix}`,
        source: "DIRECT"
      };

      async function createTransaction(entry: {
        reference: string;
        occurredAt: Date;
        ownerSide: "DEBIT" | "CREDIT";
        amount: string;
        bucket: string;
        offsetAccountId: string;
        offsetSide: "DEBIT" | "CREDIT";
      }) {
        await tx.financialTransaction.create({
          data: {
            organizationId: bootstrapOrganizationId,
            reference: entry.reference,
            occurredAt: entry.occurredAt,
            description: entry.bucket,
            postings: {
              create: [
                {
                  organizationId: bootstrapOrganizationId,
                  ledgerAccountId: entry.offsetAccountId,
                  side: entry.offsetSide,
                  amount: entry.amount,
                  currency: "MAD",
                  bucket: entry.bucket,
                  dimensions
                },
                {
                  organizationId: bootstrapOrganizationId,
                  ledgerAccountId: ownerPayable.id,
                  side: entry.ownerSide,
                  amount: entry.amount,
                  currency: "MAD",
                  bucket: entry.bucket,
                  dimensions
                }
              ]
            }
          }
        });
      }

      await createTransaction({
        reference: `TX-${input.suffix}-OPEN`,
        occurredAt: openingDate,
        ownerSide: "CREDIT",
        amount: "1000.00",
        bucket: "OWNER_REVENUE",
        offsetAccountId: bank.id,
        offsetSide: "DEBIT"
      });
      await createTransaction({
        reference: `TX-${input.suffix}-REV`,
        occurredAt: revenueDate,
        ownerSide: "CREDIT",
        amount: "8000.00",
        bucket: "OWNER_REVENUE",
        offsetAccountId: bank.id,
        offsetSide: "DEBIT"
      });
      await createTransaction({
        reference: `TX-${input.suffix}-SVC`,
        occurredAt: serviceDate,
        ownerSide: "CREDIT",
        amount: "500.00",
        bucket: "OWNER_SERVICES",
        offsetAccountId: bank.id,
        offsetSide: "DEBIT"
      });
      await createTransaction({
        reference: `TX-${input.suffix}-COM`,
        occurredAt: commissionDate,
        ownerSide: "DEBIT",
        amount: "1600.00",
        bucket: "COMMISSION",
        offsetAccountId: commissionRevenue.id,
        offsetSide: "CREDIT"
      });
      await createTransaction({
        reference: `TX-${input.suffix}-EXP`,
        occurredAt: expenseDate,
        ownerSide: "DEBIT",
        amount: "600.00",
        bucket: "OWNER_EXPENSE",
        offsetAccountId: bank.id,
        offsetSide: "CREDIT"
      });
      await createTransaction({
        reference: `TX-${input.suffix}-PAY`,
        occurredAt: payoutDate,
        ownerSide: "DEBIT",
        amount: "2000.00",
        bucket: "PAYOUT",
        offsetAccountId: bank.id,
        offsetSide: "CREDIT"
      });

      return {
        ownerEmail,
        tenantEmail,
        ownerId: owner.id,
        propertyId: property.id,
        propertyName,
        otherPropertyId: otherProperty.id,
        otherPropertyName,
        period,
        bankCode
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

export async function ownerStatementTotalsFromPostgres(input: {
  ownerId: string;
  propertyId: string;
  period: { from: string; to: string };
}): Promise<OwnerStatementTotals> {
  const prisma = new PrismaClient();
  const periodStart = dateOnlyToUtc(input.period.from);
  const periodEnd = addUtcDays(dateOnlyToUtc(input.period.to), 1);

  try {
    const rows = await prisma.$queryRaw<Array<{ side: string; amount: string; occurredAt: Date }>>`
      SELECT p.side, p.amount::text AS amount, ft.occurred_at AS "occurredAt"
      FROM posting p
      INNER JOIN ledger_account la ON la.id = p.ledger_account_id
      INNER JOIN financial_transaction ft ON ft.id = p.transaction_id
      WHERE p.organization_id = ${bootstrapOrganizationId}::uuid
        AND la.code = 'OWNER_PAYABLE'
        AND p.dimensions @> jsonb_build_object(
          'owner_id', ${input.ownerId},
          'property_id', ${input.propertyId}
        )
        AND ft.occurred_at < ${periodEnd}
    `;
    const opening = rows
      .filter((row) => row.occurredAt < periodStart)
      .map(signedAmount)
      .reduce((sum, amount) => sum.plus(amount), new Decimal(0));
    const periodRows = rows.filter(
      (row) => row.occurredAt >= periodStart && row.occurredAt < periodEnd
    );
    const credits = periodRows
      .filter((row) => row.side === "CREDIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const debits = periodRows
      .filter((row) => row.side === "DEBIT")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

    return {
      opening: opening.toFixed(2),
      credits: credits.toFixed(2),
      debits: debits.toFixed(2),
      closing: opening.plus(credits).minus(debits).toFixed(2)
    };
  } finally {
    await prisma.$disconnect();
  }
}
