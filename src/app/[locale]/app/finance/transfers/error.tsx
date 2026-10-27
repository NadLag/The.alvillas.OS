"use client";
import { useTranslations } from "next-intl";
export default function Error({reset}:{reset:()=>void}){const t=useTranslations("FinancialTransfers");return <div role="alert"><p>{t("error")}</p><button className="secondary-button" type="button" onClick={reset}>{t("retry")}</button></div>}
