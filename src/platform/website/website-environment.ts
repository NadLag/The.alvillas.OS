import { assertOrganizationId } from "@/platform/db/tenant";

export function configuredWebsiteOrganization(env: NodeJS.ProcessEnv = process.env) {
  const value = env.ALVILLAS_PUBLIC_ORGANIZATION_ID;
  if (!value) return null;
  try {
    assertOrganizationId(value);
    return value.toLowerCase();
  } catch {
    return null;
  }
}

export function publicAnalyticsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.ALVILLAS_PUBLIC_ANALYTICS === "1" && configuredWebsiteOrganization(env) !== null;
}
