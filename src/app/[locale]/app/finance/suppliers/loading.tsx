import { getTranslations } from "next-intl/server";
import { AdminShell, SkeletonBlock } from "@/design-system/shells";
export default async function Loading() { const t = await getTranslations("Suppliers"); return <AdminShell className="resource-page supplier-page"><h1>{t("title")}</h1><p className="resource-loading" role="status">{t("loading")}</p><SkeletonBlock /></AdminShell>; }
