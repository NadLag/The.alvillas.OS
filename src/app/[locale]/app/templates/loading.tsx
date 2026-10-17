import { getTranslations } from "next-intl/server";
export default async function LoadingTemplates() {
  const t = await getTranslations("Templates");
  return (
    <section className="workspace-main" role="status" aria-busy="true">
      <p>{t("loading")}</p>
      <div className="template-skeleton" />
      <div className="template-skeleton" />
    </section>
  );
}
