import { describe, expect, it } from "vitest";
import {
  renderOwnerStatementDocument,
  renderOwnerStatementPdf,
  sendOwnerStatementEmail
} from "@/modules/owner-portal/application/owner-statement-documents";
import { buildOwnerStatement, dateOnlyToUtc } from "@/modules/owner-portal/domain/owner-statement";
import { FakeEmailProvider, FakePdfRenderer } from "@/platform/providers/fakes";
import { formatCurrency, formatDate } from "@/i18n/format";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import ar from "../../messages/ar.json";

const statement = buildOwnerStatement({
  organizationId: "org-a",
  ownerId: "owner-a",
  ownerName: "Owner A",
  propertyId: "property-a",
  propertyName: "Villa Amelkis",
  periodStart: dateOnlyToUtc("2027-04-01"),
  periodEnd: dateOnlyToUtc("2027-05-01"),
  currency: "MAD",
  postings: [
    {
      id: "posting-a",
      transactionId: "tx-a",
      reference: "TX-A",
      occurredAt: new Date("2027-04-02T12:00:00.000Z"),
      description: null,
      side: "CREDIT",
      amount: "8000.00",
      currency: "MAD",
      bucket: "OWNER_REVENUE",
      dimensions: null,
      locationName: "Operating bank",
      locationCode: "BANK_A_INTERNAL"
    }
  ]
});

describe("owner statement generated documents", () => {
  it.each(["en", "fr", "ar"] as const)("preserves canonical civil dates, exact cents and escaped original labels in %s documents", locale => {
    const original = buildOwnerStatement({ organizationId: "org-original", ownerId: "owner-original", ownerName: "<Owner & original>", propertyId: "property-original", propertyName: "<Villa & original>",
      currency: "EUR", periodStart: new Date("2026-11-01T23:00:00Z"), periodEnd: new Date("2026-11-02T23:00:00Z"), postings: [{ id: "original-posting", transactionId: "original-transaction",
        reference: "<Original & retained>", occurredAt: new Date("2026-11-01T23:30:00Z"), description: null, side: "CREDIT", amount: "9007199254740993.07", currency: "EUR",
        bucket: "OWNER_REVENUE", dimensions: null, locationName: "Original bank", locationCode: "ORIGINAL_BANK" }] }),
      snapshot = { ...original, fromOn: "2026-11-02", toOn: "2026-11-02", timezone: "Europe/Paris", currencies: [{ code: "MAD" }, { code: "EUR" }] },
      before = JSON.stringify(snapshot), document = renderOwnerStatementDocument(snapshot, locale), civilDate = formatDate(locale, new Date("2026-11-02T12:00:00Z"), { timeZone: "UTC" }),
      labels = ({ en, fr, ar })[locale].OwnerStatementDocuments;
    expect(document.data.period).toBe(labels.period.replace("{from}", civilDate).replace("{to}", civilDate));
    expect(document.data.lines).toEqual([expect.objectContaining({ date: civilDate, reference: "<Original & retained>", amount: formatCurrency(locale, original.closingBalance) })]);
    expect(document.text).toContain(labels.buckets.OWNER_REVENUE); expect(document.text).toContain(formatCurrency(locale, original.closingBalance));
    expect(document.html).toContain("&lt;Original &amp; retained&gt;"); expect(document.html).not.toContain("<Owner & original>");
    expect(document.html).toContain("&lt;Owner &amp; original&gt;"); expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("renders owner statement document text in the selected EN or FR locale", () => {
    const english = renderOwnerStatementDocument(statement, "en");
    const french = renderOwnerStatementDocument(statement, "fr");

    expect(english.subject).toBe("Owner statement for Villa Amelkis");
    expect(english.text).toContain("Opening balance");
    expect(english.text).toContain("Owner revenue");
    expect(french.subject).toBe("Relevé propriétaire - Villa Amelkis");
    expect(french.text).toContain("Solde final");
    expect(french.text).toContain("Revenu propriétaire");
  });

  it("passes the selected locale through email and PDF provider calls", async () => {
    const email = new FakeEmailProvider("test");
    const pdf = new FakePdfRenderer("test");

    await expect(
      sendOwnerStatementEmail({
        provider: email,
        to: "owner@example.com",
        statement,
        selectedLocale: "fr"
      })
    ).resolves.toEqual({ id: "fake-email-1" });

    expect(email.sent[0]).toMatchObject({
      locale: "fr",
      template: "owner.statement",
      subject: "Relevé propriétaire - Villa Amelkis"
    });

    const bytes = await renderOwnerStatementPdf(pdf, statement, "fr");
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      template: "owner.statement",
      locale: "fr",
      data: {
        title: "Relevé propriétaire"
      }
    });
  });
});
