import type { TenantTransaction } from "@/platform/db/tenant";

export class WhatsappRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  reservation(id: string) {
    return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null, property: { organizationId: this.organizationId, archivedAt: null } },
      select: { id: true, propertyId: true, status: true, reference: true, guestName: true, guestPhone: true, guestPreferredLocale: true, checkIn: true, checkOut: true, property: { select: { regionId: true, cityId: true } } } });
  }
  task(id: string) {
    return this.tx.operationTask.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null, property: { organizationId: this.organizationId, archivedAt: null } },
      select: { id: true, propertyId: true, reservationId: true, state: true, assignedToUserAccountId: true, assignedToPersonId: true, dueDate: true, titleTranslations: true, property: { select: { regionId: true, cityId: true } } } });
  }
  owners(propertyId: string) {
    return this.tx.propertyOwner.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null, owner: { organizationId: this.organizationId, archivedAt: null } },
      select: { owner: { select: { id: true, displayName: true, phone: true, preferredLocale: true } } }, orderBy: { ownerId: "asc" } });
  }
  saveGuestContact(id: string, phone: string | null, locale: string) {
    return this.tx.reservation.update({ where: { organizationId: this.organizationId, id, archivedAt: null }, data: { guestPhone: phone, guestPreferredLocale: locale } });
  }
}
