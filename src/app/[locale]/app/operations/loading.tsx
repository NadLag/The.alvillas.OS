import { getTranslations } from "next-intl/server";
export default async function OperationsLoading() { const t = await getTranslations("Operations.manage"); return <section className="resource-page" aria-busy="true"><h1>{t("loading")}</h1><div className="skeleton-block" /></section>; }
