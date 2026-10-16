import { getTranslations } from "next-intl/server";
import { SkeletonBlock } from "@/design-system/shells";

export default async function Loading() {
  const t = await getTranslations("Whatsapp");
  return <div role="status" aria-label={t("preparing")}><SkeletonBlock /></div>;
}
