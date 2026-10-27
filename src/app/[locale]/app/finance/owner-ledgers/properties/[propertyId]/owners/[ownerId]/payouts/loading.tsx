import { getTranslations } from "next-intl/server";
export default async function Loading(){const t=await getTranslations("OwnerPayouts");return <p role="status">{t("loading")}</p>;}
