import { localizedText, type LocalizedText } from "@/i18n/content";
import { formatCurrency, formatDate } from "@/i18n/format";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import {
  addUtcDays,
  type OwnerStatementBucket
} from "@/modules/owner-portal/domain/owner-statement";
import type { OwnerStatementView } from "@/modules/owner-portal/application/owner-statement-presenter";
import type { EmailProvider, PdfRenderer } from "@/platform/providers";
import { escapeHtml } from "@/platform/encoding/html";

const ownerStatementTemplate = "owner.statement";

const documentLabels = {
  subject: {
    en: "Owner statement for {propertyName}",
    fr: "Releve proprietaire - {propertyName}",
    ar: "Owner statement for {propertyName}"
  },
  title: {
    en: "Owner statement",
    fr: "Releve proprietaire",
    ar: "Owner statement"
  },
  period: {
    en: "{from} to {to}",
    fr: "{from} a {to}",
    ar: "{from} to {to}"
  },
  owner: {
    en: "Owner",
    fr: "Proprietaire",
    ar: "Owner"
  },
  property: {
    en: "Property",
    fr: "Propriete",
    ar: "Property"
  },
  openingBalance: {
    en: "Opening balance",
    fr: "Solde initial",
    ar: "Opening balance"
  },
  periodCredits: {
    en: "Credits",
    fr: "Credits",
    ar: "Credits"
  },
  periodDebits: {
    en: "Debits",
    fr: "Debits",
    ar: "Debits"
  },
  closingBalance: {
    en: "Closing balance",
    fr: "Solde final",
    ar: "Closing balance"
  },
  lines: {
    en: "Statement lines",
    fr: "Lignes du releve",
    ar: "Statement lines"
  },
  noLines: {
    en: "No ledger postings were found for this period.",
    fr: "Aucune ecriture ledger pour cette periode.",
    ar: "No ledger postings were found for this period."
  }
} satisfies Record<string, LocalizedText>;

const bucketLabels = {
  OWNER_REVENUE: {
    en: "Owner revenue",
    fr: "Revenu proprietaire",
    ar: "Owner revenue"
  },
  OWNER_SERVICES: {
    en: "Owner services",
    fr: "Services proprietaire",
    ar: "Owner services"
  },
  REIMBURSEMENT: {
    en: "Reimbursement",
    fr: "Remboursement",
    ar: "Reimbursement"
  },
  COMMISSION: {
    en: "Commission",
    fr: "Commission",
    ar: "Commission"
  },
  OTA_FEE: {
    en: "OTA fee",
    fr: "Frais OTA",
    ar: "OTA fee"
  },
  OWNER_EXPENSE: {
    en: "Owner expense",
    fr: "Depense proprietaire",
    ar: "Owner expense"
  },
  PAYOUT: {
    en: "Payout",
    fr: "Paiement",
    ar: "Payout"
  },
  ADJUSTMENT: {
    en: "Adjustment",
    fr: "Ajustement",
    ar: "Adjustment"
  }
} satisfies Record<OwnerStatementBucket, LocalizedText>;

export type OwnerStatementDocument = {
  template: typeof ownerStatementTemplate;
  locale: AppLocale;
  subject: string;
  title: string;
  html: string;
  text: string;
  data: Record<string, unknown>;
};

function label(key: keyof typeof documentLabels, locale: AppLocale): string {
  return localizedText(documentLabels[key], locale);
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => values[key] ?? "");
}

function periodText(statement: OwnerStatementView, locale: AppLocale): string {
  const to = addUtcDays(statement.periodEnd, -1);

  return interpolate(label("period", locale), {
    from: formatDate(locale, statement.periodStart),
    to: formatDate(locale, to)
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
    date: formatDate(locale, line.occurredAt),
    bucket: localizedText(bucketLabels[line.bucket], locale),
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
