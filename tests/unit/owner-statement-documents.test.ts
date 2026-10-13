import { describe, expect, it } from "vitest";
import {
  renderOwnerStatementDocument,
  renderOwnerStatementPdf,
  sendOwnerStatementEmail
} from "@/modules/owner-portal/application/owner-statement-documents";
import { buildOwnerStatement, dateOnlyToUtc } from "@/modules/owner-portal/domain/owner-statement";
import { FakeEmailProvider, FakePdfRenderer } from "@/platform/providers/fakes";

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
  it("renders owner statement document text in the selected EN or FR locale", () => {
    const english = renderOwnerStatementDocument(statement, "en");
    const french = renderOwnerStatementDocument(statement, "fr");

    expect(english.subject).toBe("Owner statement for Villa Amelkis");
    expect(english.text).toContain("Opening balance");
    expect(english.text).toContain("Owner revenue");
    expect(french.subject).toBe("Releve proprietaire - Villa Amelkis");
    expect(french.text).toContain("Solde final");
    expect(french.text).toContain("Revenu proprietaire");
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
      subject: "Releve proprietaire - Villa Amelkis"
    });

    const bytes = await renderOwnerStatementPdf(pdf, statement, "fr");
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      template: "owner.statement",
      locale: "fr",
      data: {
        title: "Releve proprietaire"
      }
    });
  });
});
