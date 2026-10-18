"use client";
import { useTranslations } from "next-intl";
export default function TeamError({ reset }: { reset: () => void }) {
  const t = useTranslations("Team");
  return (
    <section className="resource-page">
      <h1>{t("result.unavailable")}</h1>
      <p>{t("retryHelp")}</p>
      <button className="primary-button" onClick={reset}>
        {t("retry")}
      </button>
    </section>
  );
}
