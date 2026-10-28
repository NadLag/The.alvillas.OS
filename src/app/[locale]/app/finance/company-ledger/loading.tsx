import { getTranslations } from "next-intl/server";
import { AdminShell, SkeletonBlock } from "@/design-system/shells";
export default async function Loading() {
  const t = await getTranslations("CompanyLedger");
  return <AdminShell className="resource-page owner-ledger-page"><h1>{t("title")}</h1><div className="resource-loading" role="status" aria-live="polite">{t("loading")}</div><SkeletonBlock /></AdminShell>;
}
