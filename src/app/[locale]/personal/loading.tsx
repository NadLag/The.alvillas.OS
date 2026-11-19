"use client";

import { useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";

export default function LoadingPersonal() {
  const t = useTranslations("Personal");
  return <div role="status" aria-label={t("loading")}><SkeletonBlock /></div>;
}
