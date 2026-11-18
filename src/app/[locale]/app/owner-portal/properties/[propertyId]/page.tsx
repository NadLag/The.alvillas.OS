import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrency, formatDate } from "@/i18n/format";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  dateOnlyToUtc,
  statementPeriodSelectionSchema,
  type OwnerStatementBucket
} from "@/modules/owner-portal/domain/owner-statement";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import {
  getOwnerStatement,
  getOwnerPropertyCondition,
  OwnerPortalAuthorizationError,
  OwnerPortalNotFoundError
} from "@/modules/owner-portal/application/owner-portal-service";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function firstSearchValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function periodFromSearch(searchParams: Record<string, SearchValue>) {
  return statementPeriodSelectionSchema.safeParse({
    from: firstSearchValue(searchParams.from),
    to: firstSearchValue(searchParams.to),
    currency: firstSearchValue(searchParams.currency)
  });

}

export default async function OwnerStatementPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<Record<string, SearchValue>>;
}>) {
  const [{ locale, propertyId }, rawSearchParams] = await Promise.all([params, searchParams]);
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session) {
    redirect(`/${appLocale}/login`);
  }

  const ctx = await ownerPortalActorContextFromSession(session);

  if (!ctx) {
    notFound();
  }

  const parsedPeriod = periodFromSearch(rawSearchParams), period = parsedPeriod.success ? parsedPeriod.data : {};
  const t = await getTranslations("OwnerPortal");
  let statement: Awaited<ReturnType<typeof getOwnerStatement>>;
  let condition: Awaited<ReturnType<typeof getOwnerPropertyCondition>>;

  try {
    [statement, condition] = await Promise.all([getOwnerStatement(ctx, propertyId, period), getOwnerPropertyCondition(ctx, propertyId)]);
  } catch (error) {
    if (
      error instanceof OwnerPortalAuthorizationError ||
      error instanceof OwnerPortalNotFoundError
    ) {
      notFound();
    }

    throw error;
  }

  const statementPath = `/${appLocale}/app/owner-portal/properties/${propertyId}`;
  const periodSearch = new URLSearchParams({ from: statement.fromOn, to: statement.toOn, currency: statement.currency }).toString();
  const annual = new URLSearchParams({ from: statement.fromOn.slice(0, 4) + "-01-01",
    to: statement.fromOn.slice(0, 4) + "-12-31", currency: statement.currency }).toString();
  const nonZeroBuckets = Object.entries(statement.bucketTotals).filter(
    ([, amount]) => !amount.amount.eq(0)
  ) as Array<[OwnerStatementBucket, (typeof statement.bucketTotals)[OwnerStatementBucket]]>;

  return (
    <OwnerShell className="resource-page" testId="owner-statement-page">
      <ShellHeader
        actions={
          <>
          <Link className="secondary-button" href={`/${appLocale}/app/owner-portal`}>
            {t("backToProperties")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/owner-portal/properties/${propertyId}/activity?from=${statement.fromOn}&to=${statement.toOn}&currency=${statement.currency}`}>
            {t("activity.title")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/owner-portal/properties/${propertyId}/funds?from=${statement.fromOn}&to=${statement.toOn}&currency=${statement.currency}`}>
            {t("funds.title")}
          </Link>
          <LocaleSwitch
            compact
            currentLocale={appLocale}
            label={t("language")}
            path={`/app/owner-portal/properties/${propertyId}?from=${statement.fromOn}&to=${statement.toOn}&currency=${statement.currency}`}
          />
          </>
        }
        eyebrow={t("statementEyebrow")}
        subtitle={t("statementPeriod", {
          from: formatDate(appLocale, dateOnlyToUtc(statement.fromOn), { timeZone: "UTC" }),
          to: formatDate(appLocale, dateOnlyToUtc(statement.toOn), { timeZone: "UTC" })
        })}
        title={statement.propertyName}
      />

      {!parsedPeriod.success && <p className="form-error" role="alert">{t("invalidPeriod")}</p>}
      <form className="statement-filters" method="get" data-testid="owner-statement-filters">
        <label className="field"><span>{t("periodFrom")}</span><input type="date" name="from" defaultValue={statement.fromOn} required data-testid="owner-statement-from" /></label>
        <label className="field"><span>{t("periodTo")}</span><input type="date" name="to" defaultValue={statement.toOn} required data-testid="owner-statement-to" /></label>
        <label className="field"><span>{t("currency")}</span><select name="currency" defaultValue={statement.currency} data-testid="owner-statement-currency">
          {statement.currencies.map(row => <option key={row.code} value={row.code}>{row.code}</option>)}
        </select></label>
        <button type="submit" className="primary-button" data-testid="owner-statement-apply">{t("applyPeriod")}</button>
      </form>

      <nav className="form-actions" aria-label={t("exports.title")}>
        <Link className="secondary-button" href={statementPath + "?currency=" + statement.currency}>{t("exports.month")}</Link>
        <Link className="secondary-button" href={statementPath + "?" + annual}>{t("exports.year")}</Link>
        <a className="secondary-button" href={statementPath + "/statement-download?" + periodSearch + "&format=csv"}>{t("exports.csv")}</a>
        <a className="secondary-button" href={statementPath + "/statement-download?" + periodSearch + "&format=pdf"}>{t("exports.pdf")}</a>
      </nav>
      <section className="statement-summary" aria-label={t("balanceSummary")}>
        <div>
          <span>{t("openingBalance")}</span>
          <strong
            data-amount={statement.openingBalance.toJSON().amount}
            data-testid="owner-statement-opening"
          >
            {formatCurrency(appLocale, statement.openingBalance)}
          </strong>
        </div>
        <div>
          <span>{t("periodCredits")}</span>
          <strong
            data-amount={statement.periodCreditTotal.toJSON().amount}
            data-testid="owner-statement-credits"
          >
            {formatCurrency(appLocale, statement.periodCreditTotal)}
          </strong>
        </div>
        <div>
          <span>{t("periodDebits")}</span>
          <strong
            data-amount={statement.periodDebitTotal.toJSON().amount}
            data-testid="owner-statement-debits"
          >
            {formatCurrency(appLocale, statement.periodDebitTotal)}
          </strong>
        </div>
        <div>
          <span>{t("closingBalance")}</span>
          <strong
            data-amount={statement.closingBalance.toJSON().amount}
            data-testid="owner-statement-closing"
          >
            {formatCurrency(appLocale, statement.closingBalance)}
          </strong>
        </div>
      </section>

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("statementLines")}</p>
            <span>{t("lineCount", { count: statement.lines.length })}</span>
          </div>
          {statement.lines.length === 0 ? (
            <EmptyState testId="owner-statement-empty" tone="motif">{t("emptyStatement")}</EmptyState>
          ) : (
            <div className="statement-table" role="table" aria-label={t("statementLines")}>
              <div role="row" className="statement-table-head">
                <span role="columnheader">{t("columns.date")}</span>
                <span role="columnheader">{t("columns.bucket")}</span>
                <span role="columnheader">{t("columns.reference")}</span>
                <span role="columnheader">{t("columns.amount")}</span>
              </div>
              {statement.lines.map((line) => (
                <div
                  role="row"
                  className="statement-table-row"
                  data-amount={line.signedAmount.toJSON().amount}
                  data-bucket={line.bucket}
                  data-testid="owner-statement-line"
                  key={line.postingId}
                >
                  <span role="cell">{formatDate(appLocale, line.occurredAt, { timeZone: statement.timezone })}</span>
                  <span role="cell">{t(`buckets.${line.bucket}`)}</span>
                  <span role="cell">
                    <strong>{line.reference}</strong>
                    <small>{line.reservationReference ?? line.source ?? t("noSource")}</small>
                  </span>
                  <span role="cell">{formatCurrency(appLocale, line.signedAmount)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="workspace-side" aria-label={t("remainingPayable")}>
          <dl className="statement-side-list">
            <div>
              <dt>{t("remainingPayable")}</dt>
              <dd data-testid="owner-money-held" data-amount={statement.closingBalance.toJSON().amount}>
                {formatCurrency(appLocale, statement.closingBalance)}
              </dd>
            </div>

          </dl>
          <div className="statement-buckets">
            <p className="panel-label">{t("bucketSummary")}</p>
            {nonZeroBuckets.map(([bucket, amount]) => (
              <div data-testid="owner-bucket-total" data-bucket={bucket} key={bucket}>
                <span>{t(`buckets.${bucket}`)}</span>
                <strong data-amount={amount.toJSON().amount}>
                  {formatCurrency(appLocale, amount)}
                </strong>
              </div>
            ))}
          </div>
        </aside>
      </div>
      <section className="panel" data-testid="owner-property-condition">
        <h2>{t("condition.title")}</h2>
        <p>{t("condition.states." + condition)}</p>
      </section>
    </OwnerShell>
  );
}
