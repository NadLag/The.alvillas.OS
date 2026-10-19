import { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { randomUUID, createHash } from "node:crypto";
import Decimal from "decimal.js";
export async function reservationManagementFixture(suffix: string) {
  const client = new PrismaClient();
  try {
    return await withTenant(client, bootstrapOrganizationId, async tx => {
      const owner = await tx.owner.create({ data: { organizationId: bootstrapOrganizationId, displayName: `Reservations owner ${suffix}` } });
      const property = await tx.property.create({ data: { organizationId: bootstrapOrganizationId, name: `Reservations villa ${suffix}`, addressLine1: "Marrakech", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [],
        propertyOwners: { create: { organizationId: bootstrapOrganizationId, ownerId: owner.id, shareBps: 10000, isPrimary: true } } } });
      await tx.configRule.create({ data: { organizationId: bootstrapOrganizationId, key: "finance.commission", scopeType: "property", scopeId: property.id, value: { rate_bps: 2000, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_CHECKOUT" }, effectiveFrom: new Date("2020-01-01"), version: 1, reason: "Reservation browser acceptance" } });
      return { propertyId: property.id, propertyName: property.name };
    });
  } finally { await client.$disconnect(); }
}
export async function reservationAcceptanceRows(propertyId: string) {
  const client = new PrismaClient();
  try { return await withTenant(client, bootstrapOrganizationId, async tx => ({ reservations: await tx.reservation.findMany({ where: { propertyId } }), tasks: await tx.operationTask.findMany({ where: { propertyId } }), snapshots: await tx.reservationFinancialSnapshot.count({ where: { linkedreservationId: { propertyId } } }) })); }
  finally { await client.$disconnect(); }
}
export async function reservationPayoutBank(propertyId: string) {
  const client = new PrismaClient();
  try { return await withTenant(client, bootstrapOrganizationId, async tx => {
    await tx.property.findFirstOrThrow({ where: { organizationId: bootstrapOrganizationId, id: propertyId } });
    return tx.ledgerAccount.create({ data: { organizationId: bootstrapOrganizationId, code: `RES_OTA_${randomUUID().replaceAll("-", "").toUpperCase()}`, name: `Reservation payout bank ${propertyId}`, accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
  }); } finally { await client.$disconnect(); }
}
export async function reservationPayoutEvidence(propertyId: string, sourceTransactionId: string) {
  const client = new PrismaClient();
  try { return await withTenant(client, bootstrapOrganizationId, async tx => {
    const settlements = await tx.airbnbSettlement.findMany({ where: { organizationId: bootstrapOrganizationId, propertyId, sourceTransactionId } });
    const transactions = await tx.financialTransaction.findMany({ where: { organizationId: bootstrapOrganizationId, postings: { some: { dimensions: { path: ["airbnb_settlement_id"], equals: settlements[0]?.id ?? "absent" } } } }, include: { postings: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } });
    const originals = transactions.filter(row => !row.reversesTransactionId), sums = new Map<string, Decimal>();
    for (const posting of transactions.flatMap(row => row.postings)) sums.set(`${posting.ledgerAccountId}:${posting.currency}`, (sums.get(`${posting.ledgerAccountId}:${posting.currency}`) ?? new Decimal(0)).add(posting.amount.mul(posting.side === "DEBIT" ? 1 : -1)));
    return { settlements: settlements.length, originals: originals.length, reversals: transactions.length - originals.length, fingerprint: createHash("sha256").update(JSON.stringify(originals)).digest("hex"), zeroBalances: [...sums.values()].every(value => value.eq(0)) };
  }); } finally { await client.$disconnect(); }
}
