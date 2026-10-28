"use client";
import { useTranslations } from "next-intl";
export default function ErrorPage({ reset }: { reset: () => void }) { const t = useTranslations("Suppliers"); return <section className="resource-page"><h1>{t("errorTitle")}</h1><p role="alert">{t("error")}</p><button className="primary-button" onClick={reset}>{t("tryAgain")}</button></section>; }
