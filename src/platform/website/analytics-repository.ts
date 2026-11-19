import type { TenantTransaction } from "@/platform/db/tenant";
import type { AppLocale } from "@/i18n/routing";
import type { PublicWebsitePath } from "./site";

export class PublicWebsiteAnalyticsRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async increment(day: string, locale: AppLocale, path: PublicWebsitePath) {
    await this.tx.$executeRaw`
      INSERT INTO public_website_daily_metric (organization_id, day, locale, page_path, page_views)
      VALUES (${this.organizationId}::uuid, ${day}::date, ${locale}, ${path}, 1)
      ON CONFLICT (organization_id, day, locale, page_path) DO UPDATE
      SET page_views = public_website_daily_metric.page_views + 1`;
  }

  list(day: string) {
    return this.tx.$queryRaw<{ locale: AppLocale; path: PublicWebsitePath; pageViews: bigint }[]>`
      SELECT locale, page_path AS path, page_views AS "pageViews"
      FROM public_website_daily_metric
      WHERE organization_id = ${this.organizationId}::uuid AND day = ${day}::date
      ORDER BY locale, page_path`;
  }
}
