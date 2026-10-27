"use client";
import { useTranslations } from "next-intl";
export default function ErrorBoundary({ reset }: { reset: () => void }) {
  const t = useTranslations("AccountingPeriods");
  return <div className="resource-page"><h1>{t("title")}</h1><p role="alert">{t("errors.error")}</p><button className="secondary-button" onClick={reset}>{t("retry")}</button></div>;
}
