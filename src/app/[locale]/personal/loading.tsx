import { getTranslations } from "next-intl/server";
import { SkeletonBlock } from "@/design-system/shells";

export default async function LoadingPersonal() {
  const t = await getTranslations({ namespace: "Personal" });
  return <div role="status" aria-label={t("loading")}><SkeletonBlock /></div>;
}
