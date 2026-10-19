import { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
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
