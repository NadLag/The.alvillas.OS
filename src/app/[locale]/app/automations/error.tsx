"use client";
import { useTranslations } from "next-intl";
export default function Error({ reset }: { reset: () => void }) {
  const t = useTranslations("Automation");
  return (
    <section className="resource-page">
      <h1>{t("loadError")}</h1>
      <p>{t("retryHelp")}</p>
      <button className="primary-button" onClick={reset}>
        {t("retry")}
      </button>
    </section>
  );
}
