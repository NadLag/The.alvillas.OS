"use client";

import { useTranslations } from "next-intl";

export default function PersonalError({ reset }: { reset: () => void }) {
  const t = useTranslations("Personal");
  return <section className="detail-panel">
    <p role="alert">{t("unavailable")}</p>
    <button className="secondary-button" onClick={reset}>{t("retry")}</button>
  </section>;
}
