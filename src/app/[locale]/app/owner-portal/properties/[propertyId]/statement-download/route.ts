import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { downloadOwnerStatement } from "@/modules/owner-portal/application/owner-statement-download";
import { statementPeriodInputSchema } from "@/modules/owner-portal/domain/owner-statement";
import { OwnerPortalAuthorizationError, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";

const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, context: { params: Promise<{ locale: string; propertyId: string }> }) {
  const [{ locale: requested, propertyId }, session] = await Promise.all([context.params, auth()]);
  const locale = safeLocale(requested);
  const params = new URL(request.url).searchParams;
  const format = z.enum(["csv", "pdf"]).safeParse(params.get("format"));
  const period = statementPeriodInputSchema.safeParse({
    from: params.get("from"), to: params.get("to"), currency: params.get("currency") ?? undefined
  });
  const actor = await ownerPortalActorContextFromSession(session);
  if (!actor || !z.uuid().safeParse(propertyId).success) return new Response(null, { status: 404, headers: noStore });
  if (!format.success || !period.success) return new Response(null, { status: 400, headers: noStore });
  const t = await getTranslations({ locale, namespace: "OwnerPortal" });
  try {
    const result = await downloadOwnerStatement(actor, propertyId, period.data, locale, format.data, {
      date: t("columns.date"), bucket: t("columns.bucket"), reference: t("columns.reference"), amount: t("columns.amount"),
      currency: t("currency"), opening: t("openingBalance"), credits: t("periodCredits"), debits: t("periodDebits"), closing: t("closingBalance"),
      bucketName: bucket => t("buckets." + bucket)
    });
    return new Response(new Uint8Array(result.bytes), { headers: {
      ...noStore, "Content-Type": format.data === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`
    } });
  } catch (error) {
    if (error instanceof OwnerPortalNotFoundError || error instanceof OwnerPortalAuthorizationError) {
      return new Response(null, { status: 404, headers: noStore });
    }
    return new Response(t("exports.unavailable"), { status: 503, headers: noStore });
  }
}
