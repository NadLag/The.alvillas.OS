import { getTranslations } from "next-intl/server";
export default async function Loading(){const t=await getTranslations("OwnerLedger");return <p className="resource-loading" role="status" aria-live="polite">{t("loading")}</p>}
