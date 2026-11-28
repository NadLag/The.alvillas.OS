import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export class GuestHubServiceOrderRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  appendDelegation(input: Omit<Prisma.GuestHubServiceOrderDelegationUncheckedCreateInput, "organizationId">) {
    return this.tx.guestHubServiceOrderDelegation.create({ data: { ...input, organizationId: this.organizationId } });
  }

  delegation(grantId: string) {
    return this.tx.guestHubServiceOrderDelegation.findUnique({ where: { organizationId_grantId: { organizationId: this.organizationId, grantId } } });
  }

  async lockLink(linkId: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-hub-service-order:${this.organizationId}:${linkId}`}, 0))::text`);
  }

  receiptByNonce(linkId: string, commandKey: string) {
    return this.tx.guestHubServiceOrderRequest.findUnique({
      where: { organizationId_linkId_commandKey: { organizationId: this.organizationId, linkId, commandKey } },
      include: { order: { select: { id: true, propertyId: true, reservationId: true, serviceKey: true, state: true, version: true, createdAt: true } } }
    });
  }

  appendReceipt(input: Omit<Prisma.GuestHubServiceOrderRequestUncheckedCreateInput, "organizationId">) {
    return this.tx.guestHubServiceOrderRequest.create({ data: { ...input, organizationId: this.organizationId } });
  }

  async validateReceipt() {
    await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_service_request_sources IMMEDIATE`);
  }
}
