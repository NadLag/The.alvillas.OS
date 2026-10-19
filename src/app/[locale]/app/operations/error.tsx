"use client";
import { useTranslations } from "next-intl";
export default function OperationsError({ reset }: { reset: () => void }) { const t = useTranslations("Operations.manage"); return <section className="resource-page"><h1>{t("errors.generic")}</h1><button className="primary-button" onClick={reset}>{t("retry")}</button></section>; }
