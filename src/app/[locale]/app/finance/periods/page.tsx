import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatDate } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { authorize } from "@/platform/authz/authorize";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { listAccountingPeriods } from "@/modules/finance/application/accounting-period-service";
import { AccountingPeriodAccessError } from "@/modules/finance/domain/accounting-period";
import { AccountingPeriodForm } from "@/modules/finance/ui/accounting-period-forms";

export const dynamic = "force-dynamic";
export default async function AccountingPeriodsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ after?: string }>;
}) {
  const { locale: raw } = await params, locale = safeLocale(raw); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const [query, t] = await Promise.all([searchParams, getTranslations("AccountingPeriods")]);
  let result;
  try { result = await listAccountingPeriods(actor, { after: query.after }); }
  catch (error) { if (error instanceof AccountingPeriodAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const canConfigure = authorize(actor.authContext, "view", { type: "config_rule", organizationId: actor.organizationId });
  return <AdminShell className="resource-page financial-accounts-page accounting-periods-page" testId="accounting-periods-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")}
      actions={<Link className="secondary-button" href={`/${locale}/app/finance/accounts`}>{t("accounts")}</Link>} />
    <section aria-label={t("policyTitle")}>
      <h2>{t("policyTitle")}</h2>
      {result.policy ? <><p>{t("policyVersion", { version: result.policy.version })}</p>
        <dl className="accounting-period-summary"><div><dt>{t("timezone")}</dt><dd>{result.policy.value.timezone}</dd></div>
          <div><dt>{t("earlyClose")}</dt><dd>{t(result.policy.value.allow_early_close ? "allowed" : "notAllowed")}</dd></div></dl>
        <p>{t("maxWindow", { seconds: result.policy.value.max_reopen_seconds })}</p></> : <p role="status" data-testid="accounting-period-policy-missing">{t("missingPolicy")}</p>}
      {canConfigure ? <Link className="secondary-button" href={`/${locale}/app/configuration`}>{t("configure")}</Link> : null}
    </section>
    {result.canClose && result.policy ? <AccountingPeriodForm kind="close" locale={locale} requestKey={crypto.randomUUID()} expectedVersion={0} /> : null}
    <section aria-label={t("periods")}><h2>{t("periods")}</h2>
      {!result.rows.length ? <p data-testid="accounting-periods-empty">{t("empty")}</p> : <ul className="resource-list">
        {result.rows.map(period => <li className="resource-card" key={period.id} data-testid="accounting-period-row">
          <h3><Link href={`/${locale}/app/finance/periods/${period.id}`}>{formatDate(locale, period.month, { dateStyle: undefined, month: "long", year: "numeric", timeZone: "UTC" })}</Link></h3>
          <p>{period.timezone}</p><p>{t(`states.${result.states[period.id]}`)}</p>
        </li>)}
      </ul>}
      {result.next ? <Link className="secondary-button" href={`/${locale}/app/finance/periods?after=${result.next}`} data-testid="accounting-periods-next">{t("more")}</Link> : null}
    </section>
  </AdminShell>;
}
