import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { DesignSystemBoard } from "@/modules/design-system/ui/design-system-board";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

export default async function DesignSystemPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session?.user?.id) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("DesignSystem");

  return (
    <AdminShell className="resource-page" testId="design-system-page">
      <ShellHeader
        actions={
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />
      <section className="workspace-main">
        <DesignSystemBoard
          labels={{
            closeDialog: t("closeDialog"),
            components: t("components"),
            dialog: t("dialog"),
            empty: t("empty"),
            error: t("error"),
            fieldAction: t("fieldAction"),
            loading: t("loading"),
            openDialog: t("openDialog"),
            shellAdmin: t("shellAdmin"),
            shellField: t("shellField"),
            shellGuest: t("shellGuest"),
            shellManager: t("shellManager"),
            shellOwner: t("shellOwner"),
            shells: t("shells"),
            showToast: t("showToast"),
            states: t("states"),
            tabsLabel: t("tabsLabel"),
            toast: t("toast"),
            toastBody: t("toastBody")
          }}
        />
      </section>
    </AdminShell>
  );
}
