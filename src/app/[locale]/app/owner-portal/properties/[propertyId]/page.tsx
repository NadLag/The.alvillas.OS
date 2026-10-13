import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatCurrency, formatDate } from "@/i18n/format";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  addUtcDays,
  defaultStatementPeriod,
  statementPeriodInputSchema,
  type OwnerStatementBucket,
  type StatementPeriodInput
} from "@/modules/owner-portal/domain/owner-statement";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import {
  getOwnerStatement,
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

function periodFromSearch(searchParams: Record<string, SearchValue>): StatementPeriodInput {
  const fallback = defaultStatementPeriod();
  const parsed = statementPeriodInputSchema.safeParse({
    from: firstSearchValue(searchParams.from) ?? fallback.from,
    to: firstSearchValue(searchParams.to) ?? fallback.to
  });

  return parsed.success ? parsed.data : fallback;
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

  const period = periodFromSearch(rawSearchParams);
  const t = await getTranslations("OwnerPortal");
  let statement: Awaited<ReturnType<typeof getOwnerStatement>>;

  try {
    statement = await getOwnerStatement(ctx, propertyId, period);
  } catch (error) {
    if (
      error instanceof OwnerPortalAuthorizationError ||
      error instanceof OwnerPortalNotFoundError
    ) {
      notFound();
    }

    throw error;
  }

  const periodEndInclusive = addUtcDays(statement.periodEnd, -1);
  const nonZeroBuckets = Object.entries(statement.bucketTotals).filter(
    ([, amount]) => !amount.amount.eq(0)
  ) as Array<[OwnerStatementBucket, (typeof statement.bucketTotals)[OwnerStatementBucket]]>;

  return (
    <section className="resource-page" data-testid="owner-statement-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("statementEyebrow")}</p>
          <h1>{statement.propertyName}</h1>
          <p>
            {t("statementPeriod", {
              from: formatDate(appLocale, statement.periodStart),
              to: formatDate(appLocale, periodEndInclusive)
            })}
          </p>
        </div>
        <div className="app-actions">
          <Link className="secondary-button" href={`/${appLocale}/app/owner-portal`}>
            {t("backToProperties")}
          </Link>
          <LocaleSwitch
            compact
            currentLocale={appLocale}
            label={t("language")}
            path={`/app/owner-portal/properties/${propertyId}?from=${period.from}&to=${period.to}`}
          />
        </div>
      </header>

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
            <p className="empty-state" data-testid="owner-statement-empty">
              {t("emptyStatement")}
            </p>
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
                  <span role="cell">{formatDate(appLocale, line.occurredAt)}</span>
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

        <aside className="workspace-side" aria-label={t("heldByAlvillas")}>
          <p className="panel-label">{t("heldByAlvillas")}</p>
          <dl className="statement-side-list">
            <div>
              <dt>{t("remainingPayable")}</dt>
              <dd data-testid="owner-money-held" data-amount={statement.closingBalance.toJSON().amount}>
                {formatCurrency(appLocale, statement.closingBalance)}
              </dd>
            </div>
            {statement.heldBreakdown.map((item) => (
              <div data-testid="owner-held-location" key={item.locationName}>
                <dt>{item.locationName === "UNALLOCATED" ? t("unallocated") : item.locationName}</dt>
                <dd data-amount={item.amount.toJSON().amount}>
                  {formatCurrency(appLocale, item.amount)}
                </dd>
              </div>
            ))}
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
    </section>
  );
}
