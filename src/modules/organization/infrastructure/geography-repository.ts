import type { Prisma } from "@prisma/client";
import type {
  CityInput,
  CitySummary,
  GeographySummary,
  RegionInput,
  RegionSummary
} from "@/modules/organization/domain/geography";
import type { TenantTransaction } from "@/platform/db/tenant";

const regionInclude = {
  _count: {
    select: {
      cities: {
        where: { archivedAt: null }
      },
      properties: {
        where: { archivedAt: null }
      }
    }
  }
} satisfies Prisma.RegionInclude;

const cityInclude = {
  region: true,
  _count: {
    select: {
      properties: {
        where: { archivedAt: null }
      }
    }
  }
} satisfies Prisma.CityInclude;

type RegionWithCounts = Prisma.RegionGetPayload<{ include: typeof regionInclude }>;
type CityWithDetails = Prisma.CityGetPayload<{ include: typeof cityInclude }>;

function regionToSummary(region: RegionWithCounts): RegionSummary {
  return {
    id: region.id,
    name: region.name,
    code: region.code ?? undefined,
    description: region.description ?? undefined,
    sortOrder: region.sortOrder,
    cityCount: region._count.cities,
    propertyCount: region._count.properties,
    archivedAt: region.archivedAt,
    createdAt: region.createdAt
  };
}

function cityToSummary(city: CityWithDetails): CitySummary {
  return {
    id: city.id,
    regionId: city.regionId ?? undefined,
    regionName: city.region?.name ?? null,
    name: city.name,
    countryCode: city.countryCode,
    timezone: city.timezone,
    sortOrder: city.sortOrder,
    propertyCount: city._count.properties,
    archivedAt: city.archivedAt,
    createdAt: city.createdAt
  };
}

export class GeographyRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async listGeography(): Promise<GeographySummary> {
    const [regions, cities] = await Promise.all([
      this.tx.region.findMany({
        where: { organizationId: this.organizationId, archivedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: regionInclude
      }),
      this.tx.city.findMany({
        where: { organizationId: this.organizationId, archivedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: cityInclude
      })
    ]);

    return {
      regions: regions.map(regionToSummary),
      cities: cities.map(cityToSummary)
    };
  }

  async findRegion(regionId: string): Promise<RegionSummary | null> {
    const region = await this.tx.region.findFirst({
      where: { id: regionId, organizationId: this.organizationId, archivedAt: null },
      include: regionInclude
    });

    return region ? regionToSummary(region) : null;
  }

  async findCity(cityId: string): Promise<CitySummary | null> {
    const city = await this.tx.city.findFirst({
      where: { id: cityId, organizationId: this.organizationId, archivedAt: null },
      include: cityInclude
    });

    return city ? cityToSummary(city) : null;
  }

  async findCityByName(input: { name: string; countryCode: string; regionId?: string }): Promise<CitySummary | null> {
    const city = await this.tx.city.findFirst({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        name: { equals: input.name, mode: "insensitive" },
        countryCode: input.countryCode,
        regionId: input.regionId ?? null
      },
      include: cityInclude
    });

    return city ? cityToSummary(city) : null;
  }

  async findRegionByName(name: string): Promise<RegionSummary | null> {
    const region = await this.tx.region.findFirst({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        name: { equals: name, mode: "insensitive" }
      },
      include: regionInclude
    });

    return region ? regionToSummary(region) : null;
  }

  async createRegion(input: RegionInput, actorId: string): Promise<RegionSummary> {
    const region = await this.tx.region.create({
      data: {
        organizationId: this.organizationId,
        name: input.name,
        code: input.code,
        description: input.description,
        sortOrder: input.sortOrder,
        createdBy: actorId
      },
      include: regionInclude
    });

    return regionToSummary(region);
  }

  async createCity(input: CityInput, actorId: string): Promise<CitySummary> {
    const city = await this.tx.city.create({
      data: {
        organizationId: this.organizationId,
        regionId: input.regionId,
        name: input.name,
        countryCode: input.countryCode,
        timezone: input.timezone,
        sortOrder: input.sortOrder,
        createdBy: actorId
      },
      include: cityInclude
    });

    return cityToSummary(city);
  }

  async archiveRegion(regionId: string): Promise<RegionSummary> {
    const region = await this.tx.region.update({
      where: { id: regionId },
      data: { archivedAt: new Date() },
      include: regionInclude
    });

    return regionToSummary(region);
  }

  async archiveCity(cityId: string): Promise<CitySummary> {
    const city = await this.tx.city.update({
      where: { id: cityId },
      data: { archivedAt: new Date() },
      include: cityInclude
    });

    return cityToSummary(city);
  }

  async countActiveRegionDependents(regionId: string): Promise<{ cities: number; properties: number }> {
    const [cities, properties] = await Promise.all([
      this.tx.city.count({
        where: { organizationId: this.organizationId, regionId, archivedAt: null }
      }),
      this.tx.property.count({
        where: { organizationId: this.organizationId, regionId, archivedAt: null }
      })
    ]);

    return { cities, properties };
  }

  async countActiveCityProperties(cityId: string): Promise<number> {
    return this.tx.property.count({
      where: { organizationId: this.organizationId, cityId, archivedAt: null }
    });
  }
}
