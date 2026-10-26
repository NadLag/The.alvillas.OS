import { getTranslations } from "next-intl/server";
export default async function Loading() {
  const t = await getTranslations("TransactionGroups");
  return <div className="resource-page" role="status" aria-busy="true"><p>{t("loading")}</p><div className="skeleton-panel" /></div>;
}
