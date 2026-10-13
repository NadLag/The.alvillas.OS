import type { Prisma } from "@prisma/client";
import type { OwnerInput, OwnerSummary, PropertyInput, PropertySummary } from "@/modules/core/domain/owner-property";
import type { TenantTransaction } from "@/platform/db/tenant";

type OwnerRow = Awaited<ReturnType<TenantTransaction["owner"]["create"]>>;
type PropertyWithOwners = Prisma.PropertyGetPayload<{
  include: {
    propertyOwners: {
      include: {
        owner: true;
      };
    };
  };
}>;

function ownerToSummary(owner: OwnerRow & { _count?: { propertyOwners: number } }): OwnerSummary {
  return {
    id: owner.id,
    displayName: owner.displayName,
    legalName: owner.legalName,
    email: owner.email,
    phone: owner.phone,
    preferredLocale: owner.preferredLocale as OwnerSummary["preferredLocale"],
    notes: owner.notes,
    propertyCount: owner._count?.propertyOwners ?? 0,
    createdAt: owner.createdAt
  };
}

function propertyToSummary(property: PropertyWithOwners): PropertySummary {
  return {
    id: property.id,
    name: property.name,
    city: property.city,
    propertyType: property.propertyType,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    maxGuests: property.maxGuests,
    timezone: property.timezone,
    status: property.status as PropertySummary["status"],
    hasPool: property.hasPool,
    hasGarden: property.hasGarden,
    amenities: Array.isArray(property.amenities)
      ? property.amenities.filter((item): item is string => typeof item === "string")
      : [],
    photoUrls: Array.isArray(property.photoUrls)
      ? property.photoUrls.filter((item): item is string => typeof item === "string")
      : [],
    owners: property.propertyOwners
      .filter((link) => !link.archivedAt)
      .map((link) => ({
        id: link.owner.id,
        displayName: link.owner.displayName,
        shareBps: link.shareBps,
        isPrimary: link.isPrimary
      })),
    createdAt: property.createdAt
  };
}

export class CoreRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async createOwner(input: OwnerInput, actorId: string): Promise<OwnerSummary> {
    const owner = await this.tx.owner.create({
      data: {
        organizationId: this.organizationId,
        displayName: input.displayName,
        legalName: input.legalName,
        email: input.email,
        phone: input.phone,
        preferredLocale: input.preferredLocale,
        notes: input.notes,
        createdBy: actorId
      }
    });

    return ownerToSummary(owner);
  }

  async listOwners(): Promise<OwnerSummary[]> {
    const owners = await this.tx.owner.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ displayName: "asc" }, { createdAt: "desc" }],
      take: 1000,
      include: {
        _count: {
          select: {
            propertyOwners: {
              where: {
                archivedAt: null
              }
            }
          }
        }
      }
    });

    return owners.map(ownerToSummary);
  }

  async findOwner(ownerId: string): Promise<OwnerSummary | null> {
    const owner = await this.tx.owner.findFirst({
      where: {
        id: ownerId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      include: {
        _count: {
          select: {
            propertyOwners: {
              where: {
                archivedAt: null
              }
            }
          }
        }
      }
    });

    return owner ? ownerToSummary(owner) : null;
  }

  async createProperty(input: PropertyInput, actorId: string): Promise<PropertySummary> {
    const property = await this.tx.property.create({
      data: {
        organizationId: this.organizationId,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        region: input.region,
        countryCode: input.countryCode,
        propertyType: input.propertyType,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        livingSpaces: input.livingSpaces,
        hasPool: input.hasPool,
        hasGarden: input.hasGarden,
        parkingSpaces: input.parkingSpaces,
        maxGuests: input.maxGuests,
        timezone: input.timezone,
        amenities: input.amenities,
        photoUrls: input.photoUrls,
        status: input.status,
        createdBy: actorId,
        propertyOwners: {
          create: {
            organizationId: this.organizationId,
            ownerId: input.ownerId,
            shareBps: 10000,
            isPrimary: true,
            createdBy: actorId
          }
        }
      },
      include: {
        propertyOwners: {
          include: {
            owner: true
          }
        }
      }
    });

    return propertyToSummary(property);
  }

  async listProperties(): Promise<PropertySummary[]> {
    const properties = await this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ city: "asc" }, { name: "asc" }],
      take: 1000,
      include: {
        propertyOwners: {
          where: {
            archivedAt: null
          },
          include: {
            owner: true
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });

    return properties.map(propertyToSummary);
  }

  async findProperty(propertyId: string): Promise<PropertySummary | null> {
    const property = await this.tx.property.findFirst({
      where: {
        id: propertyId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      include: {
        propertyOwners: {
          where: {
            archivedAt: null
          },
          include: {
            owner: true
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });

    return property ? propertyToSummary(property) : null;
  }
}
