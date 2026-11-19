import { z } from "zod";
import { appLocales } from "@/i18n/routing";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { assertOrganizationId, withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { publicWebsitePaths } from "./site";
import { websiteAnalyticsPolicyKey, websiteAnalyticsPolicySchema } from "./website-policy";
import { PublicWebsiteAnalyticsRepository } from "./analytics-repository";

export const publicWebsiteAnalyticsInput = z.object({
  locale: z.enum(appLocales),
  path: z.enum(publicWebsitePaths)
}).strict();

export function utcAnalyticsDate(instant = new Date()) {
  return instant.toISOString().slice(0, 10);
}

export async function recordPublicPageView(organizationId: string, raw: unknown, db: TenantTransactionRunner) {
  assertOrganizationId(organizationId);
  const input = publicWebsiteAnalyticsInput.parse(raw);
  await withTenant(db, organizationId, async tx => {
    const now = new Date();
    const rule = await new ConfigRuleRepository(tx, organizationId).resolve({
      key: websiteAnalyticsPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now
    });
    const policy = websiteAnalyticsPolicySchema.safeParse(rule?.parsedValue);
    if (!rule?.createdBy || !policy.success || !policy.data.enabled) return;
    const decision = await consumeRateLimit(tx, organizationId, {
      key: "website.analytics:organization", limit: policy.data.maximum_events,
      windowSeconds: policy.data.window_seconds, now
    });
    if (decision.allowed) await new PublicWebsiteAnalyticsRepository(tx, organizationId).increment(utcAnalyticsDate(now), input.locale, input.path);
  });
}

export class WebsiteAnalyticsAccessError extends Error {}

export async function listPublicPageViews(actor: AccountActorContext, day: string, db: TenantTransactionRunner) {
  const date = z.iso.date().parse(day);
  return withTenant(db, actor.organizationId, async tx => {
    await recheckAccountAuthorization(actor, tx, new Date(), [{
      action: "view", resource: { type: "report", organizationId: actor.organizationId }, organizationOnly: true
    }], new WebsiteAnalyticsAccessError());
    return new PublicWebsiteAnalyticsRepository(tx, actor.organizationId).list(date);
  });
}
