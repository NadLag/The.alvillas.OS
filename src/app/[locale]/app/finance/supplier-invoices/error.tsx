"use client";
import { useTranslations } from "next-intl";
export default function Error({ reset }: { reset: () => void }) { const t = useTranslations("SupplierInvoices"); return <main className="resource-page"><h1>{t("title")}</h1><p role="alert">{t("error")}</p><button className="secondary-button" type="button" onClick={reset}>{t("reload")}</button></main>; }
