import en from "../../../../messages/en.json" with { type: "json" };
import fr from "../../../../messages/fr.json" with { type: "json" };
import ar from "../../../../messages/ar.json" with { type: "json" };
import { formatCurrency, formatDate } from "@/i18n/format";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import {
  addUtcDays,
  dateOnlyToUtc
} from "@/modules/owner-portal/domain/owner-statement";
import type { OwnerStatementView } from "@/modules/owner-portal/application/owner-statement-presenter";
import type { EmailProvider, PdfRenderer } from "@/platform/providers";
import { escapeHtml } from "@/platform/encoding/html";

const ownerStatementTemplate = "owner.statement";

const documentLabels = { en: en.OwnerStatementDocuments, fr: fr.OwnerStatementDocuments, ar: ar.OwnerStatementDocuments };

export type OwnerStatementDocument = {
  template: typeof ownerStatementTemplate;
  locale: AppLocale;
  subject: string;
  title: string;
  html: string;
  text: string;
  data: Record<string, unknown>;
};

function label(key: Exclude<keyof typeof en.OwnerStatementDocuments, "buckets">, locale: AppLocale): string {
  return documentLabels[locale][key];
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => values[key] ?? "");
}

function periodText(statement: OwnerStatementView, locale: AppLocale): string {
  const from = statement.fromOn ? dateOnlyToUtc(statement.fromOn) : statement.periodStart,
    to = statement.toOn ? dateOnlyToUtc(statement.toOn) : addUtcDays(statement.periodEnd, -1);

  return interpolate(label("period", locale), {
    from: formatDate(locale, from, { timeZone: "UTC" }),
    to: formatDate(locale, to, { timeZone: "UTC" })
  });
}

export function renderOwnerStatementDocument(
  statement: OwnerStatementView,
  selectedLocale: string
): OwnerStatementDocument {
  const locale = safeLocale(selectedLocale);
  const title = label("title", locale);
  const subject = interpolate(label("subject", locale), {
    propertyName: statement.propertyName
  });
  const period = periodText(statement, locale);
  const summary = [
    [label("openingBalance", locale), formatCurrency(locale, statement.openingBalance)],
    [label("periodCredits", locale), formatCurrency(locale, statement.periodCreditTotal)],
    [label("periodDebits", locale), formatCurrency(locale, statement.periodDebitTotal)],
    [label("closingBalance", locale), formatCurrency(locale, statement.closingBalance)]
  ];
  const lines = statement.lines.map((line) => ({
    date: formatDate(locale, line.occurredAt, statement.timezone ? { timeZone: statement.timezone } : {}),
    bucket: documentLabels[locale].buckets[line.bucket],
    reference: line.reference,
    amount: formatCurrency(locale, line.signedAmount)
  }));
  const textLines = [
    title,
    statement.propertyName,
    period,
    `${label("owner", locale)}: ${statement.ownerName}`,
    ...summary.map(([key, value]) => `${key}: ${value}`),
    label("lines", locale),
    ...(lines.length > 0
      ? lines.map((line) => `${line.date} | ${line.bucket} | ${line.reference} | ${line.amount}`)
      : [label("noLines", locale)])
  ];
  const htmlRows = lines.length > 0
    ? lines
        .map(
          (line) =>
            `<tr><td>${escapeHtml(line.date)}</td><td>${escapeHtml(line.bucket)}</td><td>${escapeHtml(line.reference)}</td><td>${escapeHtml(line.amount)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4">${escapeHtml(label("noLines", locale))}</td></tr>`;
  const html = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(statement.propertyName)} | ${escapeHtml(period)}</p>`,
    `<p>${escapeHtml(label("owner", locale))}: ${escapeHtml(statement.ownerName)}</p>`,
    "<dl>",
    ...summary.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`),
    "</dl>",
    `<h2>${escapeHtml(label("lines", locale))}</h2>`,
    `<table><tbody>${htmlRows}</tbody></table>`
  ].join("");

  return {
    template: ownerStatementTemplate,
    locale,
    subject,
    title,
    html,
    text: textLines.join("\n"),
    data: {
      title,
      subject,
      period,
      ownerName: statement.ownerName,
      propertyName: statement.propertyName,
      summary: Object.fromEntries(summary),
      lines
    }
  };
}

export async function renderOwnerStatementPdf(
  renderer: PdfRenderer,
  statement: OwnerStatementView,
  selectedLocale: string
): Promise<Uint8Array> {
  const document = renderOwnerStatementDocument(statement, selectedLocale);

  return renderer.render({
    template: document.template,
    data: document.data,
    locale: document.locale
  });
}

export async function sendOwnerStatementEmail(input: {
  provider: EmailProvider;
  to: string;
  statement: OwnerStatementView;
  selectedLocale: string;
}): Promise<{ id: string }> {
  const document = renderOwnerStatementDocument(input.statement, input.selectedLocale);

  return input.provider.send({
    to: input.to,
    subject: document.subject,
    html: document.html,
    text: document.text,
    locale: document.locale,
    template: document.template
  });
}
