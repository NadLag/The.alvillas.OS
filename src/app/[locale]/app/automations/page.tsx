import Link from "next/link";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  automationAdmin,
  AutomationAccessError,
} from "@/platform/automation/service";
import { AutomationAdmin } from "@/platform/automation/admin";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";
export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    before?: string;
    beforeId?: string;
    propertyId?: string;
    versionsBefore?: string;
    versionsBeforeId?: string;
  }>;
}) {
  const { locale } = await params,
    appLocale = routing.locales.includes(locale as AppLocale)
      ? (locale as AppLocale)
      : routing.defaultLocale;
  setRequestLocale(appLocale);
  const actor = await reservationActorContextFromSession(await auth());
  if (!actor) redirect(`/${appLocale}/login`);
  const t = await getTranslations({
      locale: appLocale,
      namespace: "Automation",
    }),
    query = await searchParams,
    before = query.before ? new Date(query.before) : undefined,
    versionsBefore = query.versionsBefore
      ? new Date(query.versionsBefore)
      : undefined;
  let model;
  try {
    model = await automationAdmin(
      actor,
      before &&
        Number.isFinite(before.getTime()) &&
        z.uuid().safeParse(query.beforeId).success
        ? { createdAt: before, id: query.beforeId! }
        : undefined,
      {},
      {
        propertyId: z.uuid().safeParse(query.propertyId).success
          ? query.propertyId
          : undefined,
        versionsBefore:
          versionsBefore &&
          Number.isFinite(versionsBefore.getTime()) &&
          z.uuid().safeParse(query.versionsBeforeId).success
            ? { createdAt: versionsBefore, id: query.versionsBeforeId! }
            : undefined,
      },
    );
  } catch (error) {
    if (!(error instanceof AutomationAccessError)) throw error;
  }
  return (
    <AdminShell className="resource-page" testId="automation-page">
      <ShellHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("back")}
          </Link>
        }
      />
      {model ? (
        <AutomationAdmin model={model} locale={appLocale} />
      ) : (
        <section className="workspace-main">
          <p role="status">{t("denied")}</p>
        </section>
      )}
    </AdminShell>
  );
}
