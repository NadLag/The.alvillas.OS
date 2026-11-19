import { prisma } from "@/platform/db/client";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { publicWebsiteAnalyticsInput, recordPublicPageView } from "@/platform/website/analytics-service";
import { configuredWebsiteOrganization, publicAnalyticsEnabled } from "@/platform/website/website-environment";

export async function POST(request: Request) {
  const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (!publicAnalyticsEnabled() || request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1") return response;
  if (new URL(request.url).search || !isSameOriginContentType(request, "application/json") ||
    request.headers.get("sec-fetch-site") !== "same-origin") return response;
  const organizationId = configuredWebsiteOrganization();
  if (!organizationId) return response;
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, 256);
  } catch {
    return response;
  }
  const input = publicWebsiteAnalyticsInput.safeParse(raw);
  if (!input.success) return response;
  try {
    await recordPublicPageView(organizationId, input.data, prisma);
    return response;
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
