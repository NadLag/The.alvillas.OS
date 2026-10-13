import type { Prisma } from "@prisma/client";
import type {
  OrganizationSettingsInput,
  OrganizationSettingsSummary
} from "@/modules/organization/domain/organization-settings";
import type { TenantTransaction } from "@/platform/db/tenant";

const organizationInclude = {
  profile: true
} satisfies Prisma.OrganizationInclude;

type OrganizationWithProfile = Prisma.OrganizationGetPayload<{
  include: typeof organizationInclude;
}>;

function organizationToSummary(
  organization: OrganizationWithProfile,
  baseCurrencyLocked: boolean
): OrganizationSettingsSummary {
  const profile = organization.profile;

  return {
    id: organization.id,
    name: organization.name,
    legalName: profile?.legalName ?? organization.name,
    brandName: profile?.brandName ?? organization.name,
    baseCurrency: organization.baseCurrency,
    logoUrl: profile?.logoUrl ?? undefined,
    primaryColor: profile?.primaryColor ?? "#0B6B5F",
    accentColor: profile?.accentColor ?? "#9F3F1B",
    websiteUrl: profile?.websiteUrl ?? undefined,
    supportEmail: profile?.supportEmail ?? undefined,
    supportPhone: profile?.supportPhone ?? undefined,
    defaultLocale: (profile?.defaultLocale ?? "fr") as OrganizationSettingsSummary["defaultLocale"],
    timezone: profile?.timezone ?? "Africa/Casablanca",
    countryCode: profile?.countryCode ?? "MA",
    fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 1,
    createdAt: organization.createdAt,
    updatedAt: profile?.updatedAt ?? organization.updatedAt,
    baseCurrencyLocked
  };
}

export class OrganizationRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async baseCurrencyLocked(): Promise<boolean> {
    const [ledgerAccounts, transactions, postings, settlements, variances] = await Promise.all([
      this.tx.ledgerAccount.count({ where: { organizationId: this.organizationId } }),
      this.tx.financialTransaction.count({ where: { organizationId: this.organizationId } }),
      this.tx.posting.count({ where: { organizationId: this.organizationId } }),
      this.tx.airbnbSettlement.count({ where: { organizationId: this.organizationId } }),
      this.tx.variance.count({ where: { organizationId: this.organizationId } })
    ]);

    return ledgerAccounts + transactions + postings + settlements + variances > 0;
  }

  async findSettings(): Promise<OrganizationSettingsSummary | null> {
    const [organization, baseCurrencyLocked] = await Promise.all([
      this.tx.organization.findFirst({
        where: { id: this.organizationId },
        include: organizationInclude
      }),
      this.baseCurrencyLocked()
    ]);

    return organization ? organizationToSummary(organization, baseCurrencyLocked) : null;
  }

  async updateSettings(input: OrganizationSettingsInput, actorId: string): Promise<OrganizationSettingsSummary> {
    const organization = await this.tx.organization.update({
      where: { id: this.organizationId },
      data: {
        name: input.name,
        baseCurrency: input.baseCurrency,
        profile: {
          upsert: {
            update: {
              legalName: input.legalName,
              brandName: input.brandName,
              logoUrl: input.logoUrl,
              primaryColor: input.primaryColor,
              accentColor: input.accentColor,
              websiteUrl: input.websiteUrl,
              supportEmail: input.supportEmail,
              supportPhone: input.supportPhone,
              defaultLocale: input.defaultLocale,
              timezone: input.timezone,
              countryCode: input.countryCode,
              fiscalYearStartMonth: input.fiscalYearStartMonth
            },
            create: {
              legalName: input.legalName,
              brandName: input.brandName,
              logoUrl: input.logoUrl,
              primaryColor: input.primaryColor,
              accentColor: input.accentColor,
              websiteUrl: input.websiteUrl,
              supportEmail: input.supportEmail,
              supportPhone: input.supportPhone,
              defaultLocale: input.defaultLocale,
              timezone: input.timezone,
              countryCode: input.countryCode,
              fiscalYearStartMonth: input.fiscalYearStartMonth,
              createdBy: actorId
            }
          }
        }
      },
      include: organizationInclude
    });

    return organizationToSummary(organization, await this.baseCurrencyLocked());
  }
}
