"use client";
import { useTranslations } from "next-intl";
export default function TemplateError({ reset }: { reset: () => void }) {
  const t = useTranslations("Templates");
  return (
    <section className="workspace-main" role="alert">
      <p>{t("messages.generic")}</p>
      <button className="secondary-button" onClick={reset}>
        {t("retry")}
      </button>
    </section>
  );
}
