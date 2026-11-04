import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { expenseFundingWalletResource } from "@/modules/finance/domain/expense";
import { employeeCompensationCostResource } from "@/modules/finance/domain/employee-compensation-cost-resource";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { FinancialTransactionResourceRepository } from "./financial-transaction-resource-repository";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Native immutable source links protect document disclosure after corrections, releases and reassignment. */
export class FinancialAttachmentSourceRepository extends FinancialTransactionResourceRepository {
  async source(id: string) {
    const journal = await this.tx.financialTransaction.findFirst({ where: { organizationId: this.organizationId, id, sealed: true },
      select: { id: true, reference: true, occurredAt: true, reversesTransactionId: true, createdBy: true,
        postings: { orderBy: { id: "asc" }, select: { id: true, dimensions: true, amount: true, currency: true, side: true, ledgerAccount: { select: {
          id: true, code: true, accountType: true, normalSide: true, archivedAt: true,
          teamWallet: { select: { id: true, personId: true, person: { select: { archivedAt: true } } } } } } } } } });
    if (!journal || !journal.postings.length) return null;
    const originalId = journal.reversesTransactionId ?? id;
    const original = originalId === id ? journal : await this.tx.financialTransaction.findFirst({ where: { organizationId: this.organizationId, id: originalId, sealed: true },
      select: { postings: { orderBy: { id: "asc" }, select: { dimensions: true } } } });
    if (!original) return null;
    const source = (await this.transactionResources([id])).get(id); if (!source) return null;
    const dimensionIds = (key: string) => {
      const ids = new Set<string>();
      for (const posting of [...journal.postings, ...original.postings]) {
        const value = posting.dimensions;
        if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)) {
          const id = value[key]; if (typeof id !== "string" || !uuid.test(id)) return null; ids.add(id.toLowerCase());
        }
      } return [...ids];
    };
    const propertyIds = dimensionIds("property_id"), invoiceIds = dimensionIds("supplier_invoice_id");
    if (!propertyIds || !invoiceIds) return null;
    const receipt = await this.tx.cashCollection.findFirst({ where: { organizationId: this.organizationId, transactionId: originalId }, select: { propertyId: true } });
    if (receipt && !propertyIds.includes(receipt.propertyId)) propertyIds.push(receipt.propertyId);
    if (propertyIds.length === 1) source.propertyId = propertyIds[0];
    const properties = await this.tx.property.findMany({ where: { organizationId: this.organizationId, id: { in: propertyIds } }, select: { id: true, cityId: true, regionId: true }, orderBy: { id: "asc" } });
    if (properties.length !== propertyIds.length) return null;
    if (properties.length === 1) { source.city = properties[0].cityId; source.region = properties[0].regionId; }
    const extraChecks: CurrentAuthorityCheck[] = [];
    if (properties.length > 1) { source.propertyId = undefined; source.ownerId = undefined; source.reservationId = undefined;
      extraChecks.push({ action: "view", resource: source, organizationOnly: true }); }
    for (const posting of journal.postings) {
      const wallet = expenseFundingWalletResource(this.organizationId, posting.ledgerAccount, posting.amount.toString(), journal.occurredAt);
      if (wallet) extraChecks.push({ action: "view", resource: wallet });
    }
    const recognition = await this.tx.supplierInvoiceRecognitionLine.findFirst({ where: { organizationId: this.organizationId, transactionId: originalId },
      select: { invoiceLine: { select: { revision: { select: { invoiceId: true } } } } } });
    if (recognition && !invoiceIds.includes(recognition.invoiceLine.revision.invoiceId)) invoiceIds.push(recognition.invoiceLine.revision.invoiceId);
    if (invoiceIds.length) {
      const invoices = await this.tx.supplierInvoice.findMany({ where: { organizationId: this.organizationId, id: { in: invoiceIds } }, select: { id: true } });
      if (invoices.length !== invoiceIds.length) return null;
      for (const [type, dataClass] of [["supplier_invoice", "financial"], ["supplier", "personal"]] as const)
        extraChecks.push({ action: "view", resource: { type, organizationId: this.organizationId, dataClass }, organizationOnly: true });
    }
    const companyLinks = invoiceIds.length ? await this.tx.companyExpenseInvoiceLink.findMany({
      where: { organizationId: this.organizationId, invoiceLine: { revision: { invoiceId: { in: invoiceIds } } } },
      select: { id: true, companyExpenseId: true, dataClass: true, version: true, state: true }, orderBy: { id: "asc" } }) : [];
    const claimId = source.compensationRoot?.sourceRecordId;
    const employeeCosts = claimId ? await this.tx.employeeCompensationCost.findMany({ where: { organizationId: this.organizationId, claimId },
      select: { id: true, propertyId: true, reservationId: true, timezone: true, amount: true,
        submission: { select: { submittedBy: true, costOn: true } }, property: { select: { id: true, cityId: true, regionId: true } } }, orderBy: { id: "asc" } }) : [];
    for (const cost of employeeCosts) {
      const original = employeeCompensationCostResource(this.organizationId, cost.submission, cost, { ownerId: null, amount: cost.amount.toString(), status: "APPROVED" }, cost.property);
      extraChecks.push({ action: "view", resource: original, organizationOnly: !cost.propertyId },
        { action: "view", resource: { ...original, occurredAt: journal.occurredAt }, organizationOnly: !cost.propertyId });
    }
    const companyCompensationLinks = claimId ? await this.tx.companyExpenseCompensationLink.findMany({ where: { organizationId: this.organizationId, employeeCost: { claimId } },
      select: { id: true, companyExpenseId: true, dataClass: true, version: true, state: true }, orderBy: { id: "asc" } }) : [];
    if (companyLinks.length || companyCompensationLinks.length) {
      extraChecks.push({ action: "view", resource: { ...source, type: "company_expense", id: undefined, financialRecordId: undefined }, organizationOnly: true });
      if (companyLinks.some(link => link.dataClass === "STAFF_COMPENSATION")) extraChecks.push({ action: "view",
        resource: { ...source, type: "staff_compensation", id: undefined, financialRecordId: undefined }, organizationOnly: true });
    }
    const ordered = <T>(rows: readonly T[] | undefined) => rows ? [...rows].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : undefined;
    const canonicalSource = { ...source, salarySources: ordered(source.salarySources), financialSources: ordered(source.financialSources),
      companyFinancialSources: ordered(source.companyFinancialSources), walletSources: ordered(source.walletSources) };
    return { source, extraChecks, identity: commandFingerprint({ journal, original, source: canonicalSource, properties, companyLinks, companyCompensationLinks, employeeCosts, extraChecks }),
      transaction: { id: journal.id, reference: journal.reference, occurredAt: journal.occurredAt.toISOString(), amount: source.amount ?? null,
        currency: new Set(journal.postings.map(line => line.currency)).size === 1 ? journal.postings[0].currency : null } };
  }
}
