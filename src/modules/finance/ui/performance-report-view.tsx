import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { formatCurrency, formatPercentageAmount, formatRecipeQuantity } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { OrganizationReportPeriod } from "../application/organization-performance-report";
import type { AccountantExportFormat } from "../domain/accountant-export";
import type { PerformanceMetric } from "../domain/performance-report";

type Period = { fromOn: string; toOn: string; today: string; currency: string; currencies: string[]; formats: AccountantExportFormat[] };

export async function PerformanceReportFilters({ report, locale, download, filters, fields }: { report: Period; locale: AppLocale; download?: string;
  filters?: Record<string, string>; fields?: ReactNode }) {
  const t = await getTranslations("PerformanceReports");
  const query = new URLSearchParams({ ...filters, fromOn: report.fromOn, toOn: report.toOn, currency: report.currency });
  const formats = report.formats.filter(value => value !== "PDF" || locale !== "ar" ||
    Boolean(process.env.PDF_RENDERER_ENDPOINT && process.env.PDF_RENDERER_TOKEN));
  return <>
    <form className="statement-filters">
      {fields}
      <label className="field"><span>{t("from")}</span><input type="date" name="fromOn" defaultValue={report.fromOn} max={report.today} required /></label>
      <label className="field"><span>{t("to")}</span><input type="date" name="toOn" defaultValue={report.toOn} max={report.today} required /></label>
      <label className="field"><span>{t("currency")}</span><select name="currency" defaultValue={report.currency}>
        {report.currencies.map(currency => <option key={currency}>{currency}</option>)}
      </select></label>
      <button className="primary-button" type="submit">{t("apply")}</button>
    </form>
    {download && formats.length ? <nav className="form-actions" aria-label={t("exports")}>
      {formats.map(format => <a key={format} download className="secondary-button" href={download + "/" + format + "?" + query.toString()}>
        {t("download." + format)}
      </a>)}
    </nav> : null}
  </>;
}

export async function PerformancePropertyFilter({ report }: { report: Pick<OrganizationReportPeriod,
  "propertyId" | "propertyName" | "propertyOptions" | "portfolioAvailable"> }) {
  const t = await getTranslations("PerformanceReports");
  return <label className="field"><span>{t("propertyFilter")}</span>
    <select name="propertyId" defaultValue={report.propertyId ?? ""}>
      {report.portfolioAvailable ? <option value="">{t("allProperties")}</option> : null}
      {report.propertyId && report.propertyName && !report.propertyOptions.some(property => property.id === report.propertyId) ?
        <option value={report.propertyId}>{report.propertyName}</option> : null}
      {report.propertyOptions.map(property => <option key={property.id} value={property.id}>{property.name}</option>)}
    </select>
  </label>;
}

export async function PerformanceMetrics({ title, metrics, locale }: { title: string; metrics: readonly PerformanceMetric[]; locale: AppLocale }) {
  const t = await getTranslations("PerformanceReports");
  return <section className="detail-panel">
    <h2>{title}</h2>
    <dl className="detail-grid">{metrics.map(({ key, amount, count }) => <div key={key}>
      <dt>{t("metric." + key)}</dt>
      <dd className={amount ? "money" : undefined}>{amount ? formatCurrency(locale, amount) : count?.endsWith("%") ? formatPercentageAmount(locale, count.slice(0, -1), 2) : count && /^-?\d+$/u.test(count) ? new Intl.NumberFormat(locale).format(BigInt(count)) : count && /^\d+\.\d{1,2}$/u.test(count) ? formatRecipeQuantity(locale, count) : count ?? t("unavailable")}</dd>
    </div>)}</dl>
  </section>;
}
