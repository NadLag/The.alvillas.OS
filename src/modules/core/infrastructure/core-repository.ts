import type { Prisma } from "@prisma/client";
import type {
  OwnerInput,
  OwnerPayoutMethodSummary,
  OwnerRepresentativeSummary,
  OwnerSummary,
  PropertyInput,
  PropertyOperatingProfileInput,
  PropertyOperatingProfileSummary,
  PropertyOwnershipInput,
  PropertyOnboardingProfileSummary,
  PropertySummary
} from "@/modules/core/domain/owner-property";
import { defaultPropertyOperatingProfile as operatingProfileDefaults } from "@/modules/core/domain/owner-property";
import { encryptSecret } from "@/platform/auth/secret-encryption";
import type { TenantTransaction } from "@/platform/db/tenant";

const ownerInclude = {
  _count: {
    select: {
      propertyOwners: {
        where: {
          archivedAt: null
        }
      }
    }
  },
  representatives: {
    where: {
      archivedAt: null
    },
    orderBy: [{ status: "asc" }, { displayName: "asc" }]
  },
  payoutMethods: {
    where: {
      archivedAt: null
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }]
  }
} satisfies Prisma.OwnerInclude;

type OwnerWithDetails = Prisma.OwnerGetPayload<{
  include: typeof ownerInclude;
}>;
type PropertyWithOwners = Prisma.PropertyGetPayload<{
  include: {
    cityRef: {
      include: {
        region: true;
      };
    };
    onboardingProfile: true;
    operatingProfile: true;
    propertyOwners: {
      include: {
        owner: true;
      };
    };
  };
}>;

function maskedPayoutAccount(details: string): string {
  const compact = details.replace(/[^a-z0-9]/giu, "");
  const tail = compact.slice(-4).toUpperCase();

  return tail ? `**** ${tail}` : "**** stored";
}

function representativeToSummary(
  representative: OwnerWithDetails["representatives"][number]
): OwnerRepresentativeSummary {
  return {
    id: representative.id,
    displayName: representative.displayName,
    email: representative.email,
    phone: representative.phone,
    preferredLocale: representative.preferredLocale as OwnerRepresentativeSummary["preferredLocale"],
    relationship: representative.relationship,
    accessNotes: representative.accessNotes,
    validFrom: representative.validFrom,
    validTo: representative.validTo,
    status: representative.status as OwnerRepresentativeSummary["status"]
  };
}

function payoutMethodToSummary(
  method: OwnerWithDetails["payoutMethods"][number]
): OwnerPayoutMethodSummary {
  return {
    id: method.id,
    label: method.label,
    methodType: method.methodType as OwnerPayoutMethodSummary["methodType"],
    accountHolderName: method.accountHolderName,
    currency: method.currency,
    countryCode: method.countryCode,
    maskedAccount: method.maskedAccount,
    isDefault: method.isDefault,
    status: method.status as OwnerPayoutMethodSummary["status"]
  };
}

function ownerToSummary(owner: OwnerWithDetails): OwnerSummary {
  return {
    id: owner.id,
    displayName: owner.displayName,
    legalName: owner.legalName,
    email: owner.email,
    phone: owner.phone,
    preferredLocale: owner.preferredLocale as OwnerSummary["preferredLocale"],
    notes: owner.notes,
    propertyCount: owner._count?.propertyOwners ?? 0,
    representatives: owner.representatives.map(representativeToSummary),
    payoutMethods: owner.payoutMethods.map(payoutMethodToSummary),
    createdAt: owner.createdAt
  };
}

function onboardingChecklist(input: PropertyInput): Record<string, boolean | number | string> {
  return {
    ownerLinked: true,
    capacityComplete: input.maxGuests > 0,
    photos: input.photoUrls.length,
    publicDirections: Boolean(input.onboardingProfile.publicDirections),
    internalAccessNotes: Boolean(input.onboardingProfile.internalAccessNotes),
    houseRules: input.onboardingProfile.houseRules.length
  };
}

function onboardingProfileToSummary(
  profile: PropertyWithOwners["onboardingProfile"]
): PropertyOnboardingProfileSummary | null {
  if (!profile) {
    return null;
  }

  const houseRules = Array.isArray(profile.houseRules)
    ? profile.houseRules.filter((item): item is string => typeof item === "string")
    : [];
  const photoGallery = Array.isArray(profile.photoGallery)
    ? profile.photoGallery
        .filter(
          (item): item is { url: string; label?: string; sortOrder?: number } =>
            typeof item === "object" &&
            item !== null &&
            "url" in item &&
            typeof item.url === "string"
        )
        .map((item, index) => ({
          url: item.url,
          label: typeof item.label === "string" ? item.label : `Photo ${index + 1}`,
          sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : index + 1
        }))
    : [];
  const onboardingChecklistValue =
    profile.onboardingChecklist &&
    typeof profile.onboardingChecklist === "object" &&
    !Array.isArray(profile.onboardingChecklist)
      ? Object.fromEntries(
          Object.entries(profile.onboardingChecklist).filter(
            (entry): entry is [string, boolean | number | string] =>
              ["boolean", "number", "string"].includes(typeof entry[1])
          )
        )
      : {};

  return {
    headline: profile.headline,
    description: profile.description,
    publicDirections: profile.publicDirections,
    internalAccessNotes: profile.internalAccessNotes,
    houseRules,
    photoGallery,
    onboardingChecklist: onboardingChecklistValue,
    onboardingNotes: profile.onboardingNotes
  };
}

function operatingProfileToSummary(
  profile: PropertyWithOwners["operatingProfile"]
): PropertyOperatingProfileSummary | null {
  if (!profile) {
    return null;
  }

  const otherServices = Array.isArray(profile.otherServices)
    ? profile.otherServices.filter((item): item is string => typeof item === "string")
    : [];

  return {
    cleaningEnabled: profile.cleaningEnabled,
    cleaningFrequency: profile.cleaningFrequency as PropertyOperatingProfileSummary["cleaningFrequency"],
    inspectionEnabled: profile.inspectionEnabled,
    inspectionFrequency: profile.inspectionFrequency as PropertyOperatingProfileSummary["inspectionFrequency"],
    poolServiceEnabled: profile.poolServiceEnabled,
    poolServiceFrequency: profile.poolServiceFrequency as PropertyOperatingProfileSummary["poolServiceFrequency"],
    gardenServiceEnabled: profile.gardenServiceEnabled,
    gardenServiceFrequency: profile.gardenServiceFrequency as PropertyOperatingProfileSummary["gardenServiceFrequency"],
    laundryManaged: profile.laundryManaged,
    linenManaged: profile.linenManaged,
    maintenanceTrackingEnabled: profile.maintenanceTrackingEnabled,
    preventiveMaintenanceFrequency:
      profile.preventiveMaintenanceFrequency as PropertyOperatingProfileSummary["preventiveMaintenanceFrequency"],
    midStayCleaningEnabled: profile.midStayCleaningEnabled,
    midStayCleaningRuleKey: profile.midStayCleaningRuleKey,
    breakfastAvailable: profile.breakfastAvailable,
    chefAvailable: profile.chefAvailable,
    transfersAvailable: profile.transfersAvailable,
    groceriesAvailable: profile.groceriesAvailable,
    wellnessAvailable: profile.wellnessAvailable,
    otherServices,
    automationNotes: profile.automationNotes
  };
}

function propertyToSummary(property: PropertyWithOwners): PropertySummary {
  return {
    id: property.id,
    name: property.name,
    cityId: property.cityId ?? property.cityRef?.id ?? "",
    regionId: property.regionId,
    region: property.cityRef?.region?.name ?? property.region,
    city: property.cityRef?.name ?? property.city,
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
    onboardingProfile: onboardingProfileToSummary(property.onboardingProfile),
    operatingProfile: operatingProfileToSummary(property.operatingProfile),
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
        createdBy: actorId,
        representatives:
          input.representatives.length > 0
            ? {
                create: input.representatives.map((representative) => ({
                  organizationId: this.organizationId,
                  displayName: representative.displayName,
                  email: representative.email,
                  phone: representative.phone,
                  preferredLocale: representative.preferredLocale,
                  relationship: representative.relationship,
                  accessNotes: representative.accessNotes,
                  validFrom: representative.validFrom,
                  validTo: representative.validTo,
                  createdBy: actorId
                }))
              }
            : undefined,
        payoutMethods:
          input.payoutMethods.length > 0
            ? {
                create: input.payoutMethods.map((method) => ({
                  organizationId: this.organizationId,
                  label: method.label,
                  methodType: method.methodType,
                  accountHolderName: method.accountHolderName,
                  currency: method.currency,
                  countryCode: method.countryCode,
                  detailsEncrypted: encryptSecret(method.detailsPlaintext),
                  maskedAccount: maskedPayoutAccount(method.detailsPlaintext),
                  isDefault: method.isDefault,
                  createdBy: actorId
                }))
              }
            : undefined
      },
      include: ownerInclude
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
      include: ownerInclude
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
      include: ownerInclude
    });

    return owner ? ownerToSummary(owner) : null;
  }

  async createProperty(input: PropertyInput, actorId: string): Promise<PropertySummary> {
    const geography = await this.resolvePropertyGeography(input, actorId);
    const operatingProfile = input.operatingProfile ?? operatingProfileDefaults(input);
    const property = await this.tx.property.create({
      data: {
        organizationId: this.organizationId,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        cityId: geography.city.id,
        regionId: geography.city.regionId,
        city: geography.city.name,
        region: geography.city.region?.name,
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
        },
        operatingProfile: {
          create: {
            organizationId: this.organizationId,
            cleaningEnabled: operatingProfile.cleaningEnabled,
            cleaningFrequency: operatingProfile.cleaningFrequency,
            inspectionEnabled: operatingProfile.inspectionEnabled,
            inspectionFrequency: operatingProfile.inspectionFrequency,
            poolServiceEnabled: operatingProfile.poolServiceEnabled,
            poolServiceFrequency: operatingProfile.poolServiceFrequency,
            gardenServiceEnabled: operatingProfile.gardenServiceEnabled,
            gardenServiceFrequency: operatingProfile.gardenServiceFrequency,
            laundryManaged: operatingProfile.laundryManaged,
            linenManaged: operatingProfile.linenManaged,
            maintenanceTrackingEnabled: operatingProfile.maintenanceTrackingEnabled,
            preventiveMaintenanceFrequency: operatingProfile.preventiveMaintenanceFrequency,
            midStayCleaningEnabled: operatingProfile.midStayCleaningEnabled,
            midStayCleaningRuleKey: operatingProfile.midStayCleaningRuleKey,
            breakfastAvailable: operatingProfile.breakfastAvailable,
            chefAvailable: operatingProfile.chefAvailable,
            transfersAvailable: operatingProfile.transfersAvailable,
            groceriesAvailable: operatingProfile.groceriesAvailable,
            wellnessAvailable: operatingProfile.wellnessAvailable,
            otherServices: operatingProfile.otherServices,
            automationNotes: operatingProfile.automationNotes,
            createdBy: actorId
          }
        },
        onboardingProfile: {
          create: {
            organizationId: this.organizationId,
            headline: input.onboardingProfile.headline,
            description: input.onboardingProfile.description,
            publicDirections: input.onboardingProfile.publicDirections,
            internalAccessNotes: input.onboardingProfile.internalAccessNotes,
            houseRules: input.onboardingProfile.houseRules,
            photoGallery: input.photoUrls.map((url, index) => ({
              url,
              label: `Photo ${index + 1}`,
              sortOrder: index + 1
            })),
            onboardingChecklist: onboardingChecklist(input),
            onboardingNotes: input.onboardingProfile.onboardingNotes,
            createdBy: actorId
          }
        }
      },
      include: {
        cityRef: {
          include: {
            region: true
          }
        },
        onboardingProfile: true,
        operatingProfile: true,
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
        cityRef: {
          include: {
            region: true
          }
        },
        onboardingProfile: true,
        operatingProfile: true,
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
        cityRef: {
          include: {
            region: true
          }
        },
        onboardingProfile: true,
        operatingProfile: true,
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

  async replacePropertyOperatingProfile(
    propertyId: string,
    input: PropertyOperatingProfileInput,
    actorId: string
  ): Promise<PropertySummary | null> {
    const property = await this.tx.property.findFirst({
      where: {
        id: propertyId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true
      }
    });

    if (!property) {
      return null;
    }

    await this.tx.propertyOperatingProfile.upsert({
      where: {
        propertyId
      },
      update: {
        cleaningEnabled: input.cleaningEnabled,
        cleaningFrequency: input.cleaningFrequency,
        inspectionEnabled: input.inspectionEnabled,
        inspectionFrequency: input.inspectionFrequency,
        poolServiceEnabled: input.poolServiceEnabled,
        poolServiceFrequency: input.poolServiceFrequency,
        gardenServiceEnabled: input.gardenServiceEnabled,
        gardenServiceFrequency: input.gardenServiceFrequency,
        laundryManaged: input.laundryManaged,
        linenManaged: input.linenManaged,
        maintenanceTrackingEnabled: input.maintenanceTrackingEnabled,
        preventiveMaintenanceFrequency: input.preventiveMaintenanceFrequency,
        midStayCleaningEnabled: input.midStayCleaningEnabled,
        midStayCleaningRuleKey: input.midStayCleaningRuleKey,
        breakfastAvailable: input.breakfastAvailable,
        chefAvailable: input.chefAvailable,
        transfersAvailable: input.transfersAvailable,
        groceriesAvailable: input.groceriesAvailable,
        wellnessAvailable: input.wellnessAvailable,
        otherServices: input.otherServices,
        automationNotes: input.automationNotes
      },
      create: {
        organizationId: this.organizationId,
        propertyId,
        cleaningEnabled: input.cleaningEnabled,
        cleaningFrequency: input.cleaningFrequency,
        inspectionEnabled: input.inspectionEnabled,
        inspectionFrequency: input.inspectionFrequency,
        poolServiceEnabled: input.poolServiceEnabled,
        poolServiceFrequency: input.poolServiceFrequency,
        gardenServiceEnabled: input.gardenServiceEnabled,
        gardenServiceFrequency: input.gardenServiceFrequency,
        laundryManaged: input.laundryManaged,
        linenManaged: input.linenManaged,
        maintenanceTrackingEnabled: input.maintenanceTrackingEnabled,
        preventiveMaintenanceFrequency: input.preventiveMaintenanceFrequency,
        midStayCleaningEnabled: input.midStayCleaningEnabled,
        midStayCleaningRuleKey: input.midStayCleaningRuleKey,
        breakfastAvailable: input.breakfastAvailable,
        chefAvailable: input.chefAvailable,
        transfersAvailable: input.transfersAvailable,
        groceriesAvailable: input.groceriesAvailable,
        wellnessAvailable: input.wellnessAvailable,
        otherServices: input.otherServices,
        automationNotes: input.automationNotes,
        createdBy: actorId
      }
    });

    return this.findProperty(propertyId);
  }

  async replacePropertyOwnership(input: PropertyOwnershipInput, actorId: string): Promise<PropertySummary | null> {
    const property = await this.tx.property.findFirst({
      where: {
        id: input.propertyId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true
      }
    });

    if (!property) {
      return null;
    }

    const ownerIds = input.shares.map((share) => share.ownerId);
    const owners = await this.tx.owner.findMany({
      where: {
        id: {
          in: ownerIds
        },
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true
      }
    });

    if (owners.length !== new Set(ownerIds).size) {
      throw new Error("Owner does not exist in this tenant");
    }

    const existingLinks = await this.tx.propertyOwner.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId
      },
      select: {
        id: true,
        ownerId: true
      }
    });
    const existingByOwnerId = new Map(existingLinks.map((link) => [link.ownerId, link]));
    const nextOwnerIds = new Set(ownerIds);
    const archiveAt = new Date();

    await this.tx.propertyOwner.updateMany({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        archivedAt: null
      },
      data: {
        isPrimary: false
      }
    });

    await this.tx.propertyOwner.updateMany({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        ownerId: {
          notIn: [...nextOwnerIds]
        },
        archivedAt: null
      },
      data: {
        archivedAt: archiveAt,
        isPrimary: false
      }
    });

    for (const share of input.shares) {
      const existing = existingByOwnerId.get(share.ownerId);

      if (existing) {
        await this.tx.propertyOwner.update({
          where: {
            id: existing.id
          },
          data: {
            shareBps: share.shareBps,
            isPrimary: share.isPrimary,
            archivedAt: null
          }
        });
      } else {
        await this.tx.propertyOwner.create({
          data: {
            organizationId: this.organizationId,
            propertyId: input.propertyId,
            ownerId: share.ownerId,
            shareBps: share.shareBps,
            isPrimary: share.isPrimary,
            createdBy: actorId
          }
        });
      }
    }

    return this.findProperty(input.propertyId);
  }

  private async resolvePropertyGeography(
    input: PropertyInput,
    actorId: string
  ): Promise<{
    city: Prisma.CityGetPayload<{ include: { region: true } }>;
  }> {
    if (input.cityId) {
      const city = await this.tx.city.findFirst({
        where: {
          id: input.cityId,
          organizationId: this.organizationId,
          archivedAt: null
        },
        include: { region: true }
      });

      if (!city) {
        throw new Error("City does not exist in this tenant");
      }

      return { city };
    }

    const regionName = input.region?.trim();
    const region = regionName
      ? (await this.tx.region.findFirst({
          where: {
            organizationId: this.organizationId,
            archivedAt: null,
            name: { equals: regionName, mode: "insensitive" }
          }
        })) ??
        (await this.tx.region.create({
          data: {
            organizationId: this.organizationId,
            name: regionName,
            createdBy: actorId
          }
        }))
      : null;
    const cityName = input.city?.trim();

    if (!cityName) {
      throw new Error("City is required");
    }

    const city =
      (await this.tx.city.findFirst({
        where: {
          organizationId: this.organizationId,
          archivedAt: null,
          name: { equals: cityName, mode: "insensitive" },
          countryCode: input.countryCode,
          regionId: region?.id ?? null
        },
        include: { region: true }
      })) ??
      (await this.tx.city.create({
        data: {
          organizationId: this.organizationId,
          regionId: region?.id,
          name: cityName,
          countryCode: input.countryCode,
          timezone: input.timezone,
          createdBy: actorId
        },
        include: { region: true }
      }));

    return { city };
  }
}
