import { getTranslations } from "next-intl/server";
export default async function Loading() {
  const t = await getTranslations("AccountingPeriods");
  return <div className="resource-page" role="status" aria-busy="true"><h1>{t("title")}</h1><p>{t("loading")}</p></div>;
}
