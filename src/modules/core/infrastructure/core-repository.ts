import { Prisma } from "@prisma/client";
import type {
  BookingChannelInput,
  BookingChannelSummary,
  OwnerInput,
  OwnerPayoutMethodSummary,
  OwnerRepresentativeSummary,
  OwnerSummary,
  ManagementAgreementInput,
  ManagementAgreementRuleSummary,
  ManagementAgreementSummary,
  PropertyInput,
  PropertyLifecycleEventSummary,
  PropertyLifecycleStatus,
  PropertyOperatingProfileInput,
  PropertyOperatingProfileSummary,
  PropertyOwnershipInput,
  PropertyOnboardingProfileSummary,
  PropertySummary
} from "@/modules/core/domain/owner-property";
import { defaultPropertyOperatingProfile as operatingProfileDefaults,managementAgreementRuleKeys } from "@/modules/core/domain/owner-property";
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
    bookingChannels: true;
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
type BookingChannelRecord = Prisma.BookingChannelGetPayload<Record<string, never>>;
type ManagementAgreementRecord = Prisma.ManagementAgreementGetPayload<{
  select: {
    id: true;
    propertyId: true;
    reference: true;
    status: true;
    effectiveFrom: true;
    effectiveTo: true;
    createdAt: true;
  };
}>;

function maskedPayoutAccount(details: string): string {
  const compact = details.replace(/[^a-z0-9]/giu, "");
  const tail = compact.slice(-4).toUpperCase();

  return tail ? `**** ${tail}` : "**** stored";
}

function maskedSyncEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}/***`;
  } catch {
    return "*** stored";
  }
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

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function lifecycleStatus(value: unknown): PropertyLifecycleStatus | null {
  return value === "DRAFT" ||
    value === "ONBOARDING" ||
    value === "ACTIVE" ||
    value === "PAUSED" ||
    value === "OFFBOARDED"
    ? value
    : null;
}

function lifecycleEventToSummary(event: {
  id: string;
  actorId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
  occurredAt: Date;
}): PropertyLifecycleEventSummary | null {
  const before = event.before ? jsonRecord(event.before) : {};
  const after = event.after ? jsonRecord(event.after) : {};
  const toStatus = lifecycleStatus(after.status);

  if (!toStatus) {
    return null;
  }

  return {
    id: event.id,
    fromStatus: lifecycleStatus(before.status),
    toStatus,
    reason: event.reason,
    actorId: event.actorId,
    occurredAt: event.occurredAt
  };
}

function bookingChannelToSummary(channel: BookingChannelRecord): BookingChannelSummary {
  return {
    id: channel.id,
    propertyId: channel.propertyId,
    sourceKey: channel.sourceKey,
    displayName: channel.displayName,
    externalListingId: channel.externalListingId,
    listingUrl: channel.listingUrl,
    syncMode: channel.syncMode as BookingChannelSummary["syncMode"],
    importEnabled: channel.importEnabled,
    exportEnabled: channel.exportEnabled,
    maskedSyncEndpoint: channel.maskedSyncEndpoint,
    status: channel.status as BookingChannelSummary["status"],
    lastSyncAt: channel.lastSyncAt,
    lastSyncStatus: channel.lastSyncStatus,
    lastSyncMessage: channel.lastSyncMessage,
    createdAt: channel.createdAt
  };
}

function managementAgreementToSummary(
  agreement: ManagementAgreementRecord,
  rules: readonly ManagementAgreementRuleSummary[]
): ManagementAgreementSummary {
  return {
    id: agreement.id,
    propertyId: agreement.propertyId,
    reference: agreement.reference,
    status: agreement.status as ManagementAgreementSummary["status"],
    effectiveFrom: agreement.effectiveFrom,
    effectiveTo: agreement.effectiveTo,
    createdAt: agreement.createdAt,
    rules: [...rules].sort((left, right) => {
      const keyOrder = left.key.localeCompare(right.key);

      if (keyOrder !== 0) {
        return keyOrder;
      }

      return right.version - left.version;
    })
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
    livingSpaces: property.livingSpaces,
    parkingSpaces: property.parkingSpaces,
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
    lifecycleEvents: [],
    bookingChannels: property.bookingChannels
      .filter((channel) => !channel.archivedAt)
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
      .map(bookingChannelToSummary),
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

  /** Acquisition linking reads identity alone; payout and financial relations stay outside this query. */
  findOwnerIdentityHead(ownerId:string,includeArchived=false){
    return this.tx.owner.findFirst({where:{organizationId:this.organizationId,id:ownerId,...includeArchived?{}:{archivedAt:null}},select:{id:true,organizationId:true,createdAt:true,updatedAt:true,archivedAt:true}});
  }

  async lockOwnerIdentity(ownerId:string){await this.tx.$queryRaw(Prisma.sql`SELECT id FROM owner WHERE organization_id=${this.organizationId}::uuid AND id=${ownerId}::uuid AND archived_at IS NULL FOR UPDATE`);}

  async ownerIdentitySourceWitness(ownerId:string,includeArchived=false){
    const rows=await this.tx.$queryRaw<Array<{id:string;organizationId:string;createdAt:Date;updatedAt:Date;archivedAt:Date|null;xmin:string;tuple:string}>>(Prisma.sql`SELECT o.id,o.organization_id AS "organizationId",o.created_at AS "createdAt",o.updated_at AS "updatedAt",o.archived_at AS "archivedAt",o.xmin::text AS xmin,o.ctid::text AS tuple FROM owner o WHERE o.organization_id=${this.organizationId}::uuid AND o.id=${ownerId}::uuid AND (${includeArchived}::boolean OR o.archived_at IS NULL)`);
    return rows[0]??null;
  }

  findOwnerIdentity(ownerId:string){
    return this.tx.owner.findFirst({where:{organizationId:this.organizationId,id:ownerId,archivedAt:null},select:{id:true,organizationId:true,displayName:true,email:true,phone:true,preferredLocale:true,createdAt:true,updatedAt:true}});
  }

  ownerIdentityPage(query:string,after:string|undefined,asOf:Date){
    return this.tx.owner.findMany({where:{organizationId:this.organizationId,archivedAt:null,createdAt:{lte:asOf},...after?{id:{gt:after}}:{},OR:[{displayName:{contains:query,mode:"insensitive"}},{email:{contains:query,mode:"insensitive"}}]},select:{id:true,organizationId:true,displayName:true,email:true,phone:true,preferredLocale:true,createdAt:true,updatedAt:true},orderBy:{id:"asc"},take:51});
  }

  ownerIdentityRows(ids:readonly string[]){return this.tx.owner.findMany({where:{organizationId:this.organizationId,archivedAt:null,id:{in:[...ids]}},select:{id:true,organizationId:true,displayName:true,email:true,phone:true,preferredLocale:true,createdAt:true,updatedAt:true}});}

  /** Source witnesses include each active ownership tuple, without loading financial relations. */
  onboardingPropertyHeads(ids:readonly string[],includeArchived=false){
    return this.tx.$queryRaw<Array<{
      id:string;organizationId:string;status:string;cityId:string|null;regionId:string|null;
      createdBy:string|null;createdAt:Date;updatedAt:Date;archivedAt:Date|null;xmin:string;tuple:string;
      ownership:Array<{id:string;ownerId:string;isPrimary:boolean;xmin:string;tuple:string}>;
      operatingProfile:{id:string;xmin:string;tuple:string}|null;
    }>>(Prisma.sql`SELECT p.id,p.organization_id AS "organizationId",p.status,p.city_id AS "cityId",p.region_id AS "regionId",p.created_by AS "createdBy",p.created_at AS "createdAt",p.updated_at AS "updatedAt",p.archived_at AS "archivedAt",p.xmin::text AS xmin,p.ctid::text AS tuple,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',po.id,'ownerId',po.owner_id,'isPrimary',po.is_primary,'xmin',po.xmin::text,'tuple',po.ctid::text) ORDER BY po.owner_id) FROM property_owner po WHERE po.organization_id=p.organization_id AND po.property_id=p.id AND po.archived_at IS NULL),'[]'::jsonb) AS ownership,
      (SELECT jsonb_build_object('id',op.id,'xmin',op.xmin::text,'tuple',op.ctid::text) FROM property_operating_profile op WHERE op.organization_id=p.organization_id AND op.property_id=p.id) AS "operatingProfile"
      FROM property p WHERE p.organization_id=${this.organizationId}::uuid AND p.id=ANY(${[...ids]}::uuid[]) AND (${includeArchived}::boolean OR p.archived_at IS NULL) ORDER BY p.id`);
  }

  async lockOnboardingProperty(propertyId:string){
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM property WHERE organization_id=${this.organizationId}::uuid AND id=${propertyId}::uuid AND archived_at IS NULL FOR UPDATE`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM property_owner WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid AND archived_at IS NULL ORDER BY id FOR UPDATE`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM property_operating_profile WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid FOR UPDATE`);
  }

  onboardingPropertyIdentityRows(ids:readonly string[],includeArchived=false){
    return this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},...includeArchived?{}:{archivedAt:null}},select:{id:true,organizationId:true,name:true,addressLine1:true,addressLine2:true,cityId:true,regionId:true,city:true,region:true,countryCode:true,propertyType:true,bedrooms:true,bathrooms:true,livingSpaces:true,hasPool:true,hasGarden:true,parkingSpaces:true,maxGuests:true,timezone:true,amenities:true,photoUrls:true,status:true,createdAt:true,updatedAt:true,archivedAt:true}});
  }

  onboardingPropertyOperatingProfile(propertyId:string){
    return this.tx.propertyOperatingProfile.findFirst({where:{organizationId:this.organizationId,propertyId},select:{cleaningEnabled:true,cleaningFrequency:true,inspectionEnabled:true,inspectionFrequency:true,poolServiceEnabled:true,poolServiceFrequency:true,gardenServiceEnabled:true,gardenServiceFrequency:true,laundryManaged:true,linenManaged:true,maintenanceTrackingEnabled:true,preventiveMaintenanceFrequency:true,midStayCleaningEnabled:true,midStayCleaningRuleKey:true,breakfastAvailable:true,chefAvailable:true,transfersAvailable:true,groceriesAvailable:true,wellnessAvailable:true,otherServices:true,automationNotes:true}});
  }

  onboardingPropertyPage(ownerId:string,query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT p.id FROM property p JOIN property_owner po ON po.organization_id=p.organization_id AND po.property_id=p.id
      WHERE p.organization_id=${this.organizationId}::uuid AND po.organization_id=${this.organizationId}::uuid AND po.owner_id=${ownerId}::uuid AND po.archived_at IS NULL AND po.created_at<=${asOf}
      AND p.archived_at IS NULL AND p.status IN ('DRAFT','ONBOARDING') AND p.created_at<=${asOf} AND p.name ILIKE ${"%"+query+"%"}
      ${after?Prisma.sql`AND p.id>${after}::uuid`:Prisma.empty} ORDER BY p.id LIMIT 51`);
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
        bookingChannels: {
          where: {
            archivedAt: null
          },
          orderBy: [{ sourceKey: "asc" }]
        },
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
        bookingChannels: {
          where: {
            archivedAt: null
          },
          orderBy: [{ sourceKey: "asc" }]
        },
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
        bookingChannels: {
          where: {
            archivedAt: null
          },
          orderBy: [{ sourceKey: "asc" }]
        },
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

    if (!property) {
      return null;
    }

    return {
      ...propertyToSummary(property),
      lifecycleEvents: await this.listPropertyLifecycleEvents(propertyId)
    };
  }

  async listPropertyLifecycleEvents(propertyId: string): Promise<PropertyLifecycleEventSummary[]> {
    const events = await this.tx.auditLog.findMany({
      where: {
        organizationId: this.organizationId,
        action: "property.lifecycle.transition",
        resourceType: "property",
        resourceId: propertyId
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        actorId: true,
        before: true,
        after: true,
        reason: true,
        occurredAt: true
      }
    });

    return events.flatMap((event) => {
      const summary = lifecycleEventToSummary(event);
      return summary ? [summary] : [];
    });
  }

  async updatePropertyStatus(
    propertyId: string,
    status: PropertyLifecycleStatus
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

    await this.tx.property.update({
      where: {
        id: propertyId
      },
      data: {
        status
      }
    });

    return this.findProperty(propertyId);
  }

  async findBookingChannel(
    propertyId: string,
    sourceKey: string
  ): Promise<BookingChannelSummary | null> {
    const channel = await this.tx.bookingChannel.findFirst({
      where: {
        organizationId: this.organizationId,
        propertyId,
        sourceKey,
        archivedAt: null
      }
    });

    return channel ? bookingChannelToSummary(channel) : null;
  }

  recordBookingChannelSync(channelId: string, at: Date, status: string) {
    return this.tx.bookingChannel.update({ where: { id: channelId, organizationId: this.organizationId }, data: { lastSyncAt: at, lastSyncStatus: status } });
  }

  async upsertBookingChannel(
    input: BookingChannelInput,
    actorId: string
  ): Promise<BookingChannelSummary | null> {
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

    const existing = await this.tx.bookingChannel.findFirst({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        sourceKey: input.sourceKey
      }
    });
    const endpointPatch = input.syncEndpointUrl
      ? {
          syncEndpointEncrypted: encryptSecret(input.syncEndpointUrl),
          maskedSyncEndpoint: maskedSyncEndpoint(input.syncEndpointUrl)
        }
      : {};
    const data = {
      displayName: input.displayName,
      externalListingId: input.externalListingId ?? null,
      listingUrl: input.listingUrl ?? null,
      syncMode: input.syncMode,
      importEnabled: input.importEnabled,
      exportEnabled: input.exportEnabled,
      status: input.status,
      archivedAt: null,
      ...endpointPatch
    };
    const channel = existing
      ? await this.tx.bookingChannel.update({
          where: {
            id: existing.id
          },
          data
        })
      : await this.tx.bookingChannel.create({
          data: {
            organizationId: this.organizationId,
            propertyId: input.propertyId,
            sourceKey: input.sourceKey,
            createdBy: actorId,
            ...data
          }
        });

    if (input.syncEndpointUrl) await this.tx.reservationFeed.updateMany({
      where: { organizationId: this.organizationId, bookingChannelId: channel.id },
      data: { etag: null, lastModified: null, lastSuccessAt: null, lastAttemptAt: null, lastError: null, consecutiveFailures: 0, nextSyncAt: new Date(), leaseToken: null, leasedUntil: null }
    });
    return bookingChannelToSummary(channel);
  }

  async createManagementAgreement(
    input: ManagementAgreementInput,
    actorId: string
  ): Promise<ManagementAgreementSummary> {
    const agreement = await this.tx.managementAgreement.create({
      data: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        reference: input.reference,
        status: input.status,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        createdBy: actorId
      }
    });

    return managementAgreementToSummary(agreement, []);
  }

  /** Native identity and tuple pins precede any private agreement/configuration value read. */
  onboardingManagementAgreementHeads(ids:readonly string[],includeArchived=false){
    return this.tx.$queryRaw<Array<{id:string;organizationId:string;propertyId:string;status:string;effectiveFrom:Date;effectiveTo:Date|null;createdBy:string|null;createdAt:Date;archivedAt:Date|null;xmin:string;tuple:string}>>(Prisma.sql`SELECT id,organization_id AS "organizationId",property_id AS "propertyId",status,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",created_by AS "createdBy",created_at AS "createdAt",archived_at AS "archivedAt",xmin::text,ctid::text AS tuple FROM management_agreement WHERE organization_id=${this.organizationId}::uuid AND id=ANY(${[...ids]}::uuid[]) AND (${includeArchived}::boolean OR archived_at IS NULL) ORDER BY id`);
  }

  onboardingManagementAgreementRows(ids:readonly string[],includeArchived=false){
    return this.tx.managementAgreement.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},...includeArchived?{}:{archivedAt:null}},select:{id:true,organizationId:true,propertyId:true,reference:true,status:true,effectiveFrom:true,effectiveTo:true,createdBy:true,createdAt:true,archivedAt:true},orderBy:{id:"asc"}});
  }

  /** Match the existing canonical agreement summary's latest version for each registered group. */
  onboardingManagementAgreementRuleHeads(agreementId:string){
    return this.tx.$queryRaw<Array<{id:string;key:string;version:number;scopeType:string;scopeId:string;lifecycle:string;effectiveFrom:Date;effectiveTo:Date|null;createdBy:string|null;createdAt:Date;xmin:string;tuple:string}>>(Prisma.sql`SELECT DISTINCT ON (key) id,key,version,scope_type AS "scopeType",scope_id AS "scopeId",lifecycle,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",created_by AS "createdBy",created_at AS "createdAt",xmin::text,ctid::text AS tuple FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND scope_type='agreement' AND scope_id=${agreementId}::uuid AND archived_at IS NULL AND key=ANY(${[...managementAgreementRuleKeys]}::text[]) ORDER BY key,version DESC`);
  }

  onboardingManagementAgreementRuleRows(ids:readonly string[]){
    return this.tx.configRule.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},scopeType:"agreement",archivedAt:null,key:{in:[...managementAgreementRuleKeys]}},select:{id:true,key:true,version:true,scopeType:true,scopeId:true,lifecycle:true,effectiveFrom:true,effectiveTo:true,createdBy:true,createdAt:true,reason:true,value:true},orderBy:{key:"asc"}});
  }

  onboardingManagementAgreementPage(propertyId:string,query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT id FROM management_agreement WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid AND archived_at IS NULL AND status IN ('DRAFT','ACTIVE') AND created_at<=${asOf} AND reference ILIKE ${"%"+query+"%"} ${after?Prisma.sql`AND id>${after}::uuid`:Prisma.empty} ORDER BY id LIMIT 51`);
  }

  async listManagementAgreementsForProperty(
    propertyId: string,
    keys: readonly string[]
  ): Promise<ManagementAgreementSummary[]> {
    const agreements = await this.tx.managementAgreement.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId,
        archivedAt: null
      },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }]
    });
    const agreementIds = agreements.map((agreement) => agreement.id);

    if (agreementIds.length === 0) {
      return [];
    }

    const rules = await this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        scopeType: "agreement",
        scopeId: {
          in: agreementIds
        },
        key: {
          in: [...keys]
        }
      },
      orderBy: [
        { scopeId: "asc" },
        { key: "asc" },
        { effectiveFrom: "desc" },
        { version: "desc" }
      ],
      select: {
        id: true,
        key: true,
        scopeId: true,
        value: true,
        version: true,
        lifecycle: true,
        effectiveFrom: true,
        effectiveTo: true,
        reason: true,
        createdAt: true
      }
    });
    const rulesByAgreementId = new Map<string, ManagementAgreementRuleSummary[]>();

    for (const rule of rules) {
      if (!rule.scopeId) {
        continue;
      }

      const entries = rulesByAgreementId.get(rule.scopeId) ?? [];
      entries.push({
        id: rule.id,
        key: rule.key,
        version: rule.version,
        lifecycle: rule.lifecycle as ManagementAgreementRuleSummary["lifecycle"],
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        reason: rule.reason,
        createdAt: rule.createdAt,
        value: jsonRecord(rule.value)
      });
      rulesByAgreementId.set(rule.scopeId, entries);
    }

    return agreements.map((agreement) =>
      managementAgreementToSummary(agreement, rulesByAgreementId.get(agreement.id) ?? [])
    );
  }

  async findManagementAgreement(
    agreementId: string,
    keys: readonly string[]
  ): Promise<ManagementAgreementSummary | null> {
    const agreement = await this.tx.managementAgreement.findFirst({
      where: {
        id: agreementId,
        organizationId: this.organizationId,
        archivedAt: null
      }
    });

    if (!agreement) {
      return null;
    }

    const summaries = await this.listManagementAgreementsForProperty(agreement.propertyId, keys);

    return summaries.find((candidate) => candidate.id === agreementId) ?? null;
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
        midStayCleaningRuleKey: input.midStayCleaningRuleKey ?? null,
        breakfastAvailable: input.breakfastAvailable,
        chefAvailable: input.chefAvailable,
        transfersAvailable: input.transfersAvailable,
        groceriesAvailable: input.groceriesAvailable,
        wellnessAvailable: input.wellnessAvailable,
        otherServices: input.otherServices,
        automationNotes: input.automationNotes ?? null
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
        (await this.ensurePropertyRegion(regionName, actorId))
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
      (await this.ensurePropertyCity(cityName, region?.id ?? null, input.countryCode, input.timezone, actorId));

    return { city };
  }

  private async ensurePropertyRegion(name: string, actorId: string) {
    await this.tx.$executeRaw(Prisma.sql`
      INSERT INTO region (organization_id, name, created_by)
      VALUES (${this.organizationId}::uuid, ${name}, ${actorId}::uuid)
      ON CONFLICT DO NOTHING
    `);
    return this.tx.region.findFirstOrThrow({ where: {
      organizationId: this.organizationId, archivedAt: null, name: { equals: name, mode: "insensitive" }
    } });
  }

  private async ensurePropertyCity(name: string, regionId: string | null, countryCode: string, timezone: string, actorId: string) {
    await this.tx.$executeRaw(Prisma.sql`
      INSERT INTO city (organization_id, region_id, name, country_code, timezone, created_by)
      VALUES (${this.organizationId}::uuid, ${regionId}::uuid, ${name}, ${countryCode}, ${timezone}, ${actorId}::uuid)
      ON CONFLICT DO NOTHING
    `);
    return this.tx.city.findFirstOrThrow({ where: {
      organizationId: this.organizationId, archivedAt: null, regionId, countryCode, name: { equals: name, mode: "insensitive" }
    }, include: { region: true } });
  }
}
