"use client";

import { useTranslations } from "next-intl";

export default function CommandCenterError({ reset }: { reset: () => void }) {
  const t = useTranslations("CommandDashboard");
  return <section className="resource-page">
    <h1>{t("error")}</h1><button type="button" className="primary-button" onClick={reset}>{t("retry")}</button>
  </section>;
}
