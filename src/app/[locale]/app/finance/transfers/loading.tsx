import { getTranslations } from "next-intl/server";
export default async function Loading(){const t=await getTranslations("FinancialTransfers");return <p role="status">{t("loading")}</p>}
