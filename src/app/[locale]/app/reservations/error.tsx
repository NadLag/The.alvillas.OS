"use client";
import { useTranslations } from "next-intl";
export default function Error({ reset }: { reset: () => void }) {
  const t = useTranslations("ReservationManagement");
  return <section className="workspace-main" role="alert"><h2>{t("errors.generic")}</h2><button className="secondary-button" onClick={reset}>{t("retry")}</button></section>;
}
