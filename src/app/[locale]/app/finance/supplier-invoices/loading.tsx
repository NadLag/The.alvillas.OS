import { getTranslations } from "next-intl/server";
import { SkeletonBlock } from "@/design-system/shells";
export default async function Loading() { const t = await getTranslations("SupplierInvoices"); return <main className="resource-page"><h1>{t("title")}</h1><p role="status">{t("loading")}</p><SkeletonBlock /></main>; }
