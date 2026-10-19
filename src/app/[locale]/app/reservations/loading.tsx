import { getTranslations } from "next-intl/server";
export default async function Loading() {
  const t = await getTranslations("ReservationManagement");
  return <section className="workspace-main" aria-busy="true" role="status"><p>{t("loading")}</p><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" /></section>;
}
