import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AuthContext } from "@/platform/authz/authorize";
import { exceptionSections } from "./exceptions";

export async function CommandCenterExceptionsLink({ context, locale }: { context: AuthContext; locale: string }) {
  if (!exceptionSections(context).length) return null;
  const t = await getTranslations("CommandExceptions");
  return <Link className="secondary-button" href={`/${locale}/app/command-center/exceptions`}>{t("title")}</Link>;
}
