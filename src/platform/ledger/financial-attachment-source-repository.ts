import type { Prisma } from "@prisma/client";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { expenseFundingWalletResource } from "@/modules/finance/domain/expense";
import { employeeCompensationCostResource } from "@/modules/finance/domain/employee-compensation-cost-resource";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { FinancialTransactionResourceRepository, type NativeFinancialResource } from "./financial-transaction-resource-repository";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Native immutable source links protect document disclosure after corrections, releases and reassignment. */
const attachmentJournalSelect={ id: true, reference: true, occurredAt: true, reversesTransactionId: true, createdBy: true,
        postings: { orderBy: { id: "asc" }, select: { id: true, dimensions: true, amount: true, currency: true, side: true, ledgerAccount: { select: {
          id: true, code: true, accountType: true, normalSide: true, archivedAt: true,
          teamWallet: { select: { id: true, personId: true, person: { select: { archivedAt: true } } } } } } } } } as const;
type AttachmentJournal=Prisma.FinancialTransactionGetPayload<{select:typeof attachmentJournalSelect}>;
const attachmentOriginalSelect={ postings: { orderBy: { id: "asc" }, select: { dimensions: true } } } as const;
type AttachmentOriginal=Prisma.FinancialTransactionGetPayload<{select:typeof attachmentOriginalSelect}>;
const attachmentReceiptSelect={ propertyId: true } as const;
type AttachmentReceipt=Prisma.CashCollectionGetPayload<{select:typeof attachmentReceiptSelect}>;
const attachmentPropertiesSelect={ id: true, cityId: true, regionId: true } as const;
type AttachmentProperties=Prisma.PropertyGetPayload<{select:typeof attachmentPropertiesSelect}>;
const attachmentRecognitionSelect={ invoiceLine: { select: { revision: { select: { invoiceId: true } } } } } as const;
type AttachmentRecognition=Prisma.SupplierInvoiceRecognitionLineGetPayload<{select:typeof attachmentRecognitionSelect}>;
const attachmentInvoicesSelect={ id: true } as const;
type AttachmentInvoices=Prisma.SupplierInvoiceGetPayload<{select:typeof attachmentInvoicesSelect}>;
const attachmentCompanyLinksSelect={ id: true, companyExpenseId: true, dataClass: true, version: true, state: true } as const;
type AttachmentCompanyLinks=Prisma.CompanyExpenseInvoiceLinkGetPayload<{select:typeof attachmentCompanyLinksSelect}>;
const attachmentEmployeeCostsSelect={ id: true, propertyId: true, reservationId: true, timezone: true, amount: true,
        submission: { select: { submittedBy: true, costOn: true } }, property: { select: { id: true, cityId: true, regionId: true } } } as const;
type AttachmentEmployeeCosts=Prisma.EmployeeCompensationCostGetPayload<{select:typeof attachmentEmployeeCostsSelect}>;
const attachmentCompanyCompensationLinksSelect={ id: true, companyExpenseId: true, dataClass: true, version: true, state: true } as const;
type AttachmentCompanyCompensationLinks=Prisma.CompanyExpenseCompensationLinkGetPayload<{select:typeof attachmentCompanyCompensationLinksSelect}>;

export class FinancialAttachmentSourceRepository extends FinancialTransactionResourceRepository {
  private attachmentResourceReads?:Map<string,NativeFinancialResource>;
  private attachmentJournalReads?:Map<string,AttachmentJournal|null>;
  private attachmentOriginalReads?:Map<string,AttachmentOriginal|null>;
  private attachmentReceiptReads?:Map<string,AttachmentReceipt[]>;
  private attachmentPropertiesReads?:Map<string,AttachmentProperties|null>;
  private attachmentRecognitionReads?:Map<string,AttachmentRecognition[]>;
  private attachmentInvoicesReads?:Map<string,AttachmentInvoices|null>;
  private attachmentCompanyLinksReads?:Map<string,AttachmentCompanyLinks[]>;
  private attachmentEmployeeCostsReads?:Map<string,AttachmentEmployeeCosts[]>;
  private attachmentCompanyCompensationLinksReads?:Map<string,AttachmentCompanyCompensationLinks[]>;
  private async attachmentJournal(id:string){if(this.attachmentJournalReads?.has(id))return this.attachmentJournalReads.get(id)??null;return this.tx.financialTransaction.findFirst({ where: { organizationId: this.organizationId, id, sealed: true },
      select:attachmentJournalSelect});}
  private async attachmentOriginal(originalId:string){if(this.attachmentOriginalReads?.has(originalId))return this.attachmentOriginalReads.get(originalId)??null;return this.tx.financialTransaction.findFirst({ where: { organizationId: this.organizationId, id: originalId, sealed: true },
      select:attachmentOriginalSelect});}
  private async attachmentReceipt(originalId:string){const rows=this.attachmentReceiptReads?.get(originalId);if(rows&&rows.length<=1)return rows[0]??null;return this.tx.cashCollection.findFirst({ where: { organizationId: this.organizationId, transactionId: originalId }, select:attachmentReceiptSelect});}
  private async attachmentProperties(propertyIds:string[]){const reads=this.attachmentPropertiesReads;if(reads&&propertyIds.every(id=>reads.has(id))){const rows=propertyIds.flatMap(id=>{const row=reads.get(id);return row?[row]:[];});return rows.sort((a,b)=>a.id.localeCompare(b.id));}return this.tx.property.findMany({ where: { organizationId: this.organizationId, id: { in: propertyIds } }, select:attachmentPropertiesSelect});}
  private async attachmentRecognition(originalId:string){const rows=this.attachmentRecognitionReads?.get(originalId);if(rows&&rows.length<=1)return rows[0]??null;return this.tx.supplierInvoiceRecognitionLine.findFirst({ where: { organizationId: this.organizationId, transactionId: originalId },
      select:attachmentRecognitionSelect});}
  private async attachmentInvoices(invoiceIds:string[]){const reads=this.attachmentInvoicesReads;if(reads&&invoiceIds.every(id=>reads.has(id))){const rows=invoiceIds.flatMap(id=>{const row=reads.get(id);return row?[row]:[];});return rows;}return this.tx.supplierInvoice.findMany({ where: { organizationId: this.organizationId, id: { in: invoiceIds } }, select:attachmentInvoicesSelect});}
  private async attachmentCompanyLinks(invoiceIds:string[]){const reads=this.attachmentCompanyLinksReads;if(reads&&invoiceIds.every(id=>reads.has(id)))return[...new Map(invoiceIds.flatMap(id=>reads.get(id)??[]).map(row=>[row.id,row])).values()].sort((a,b)=>a.id.localeCompare(b.id));return this.tx.companyExpenseInvoiceLink.findMany({
      where: { organizationId: this.organizationId, invoiceLine: { revision: { invoiceId: { in: invoiceIds } } } },
      select:attachmentCompanyLinksSelect});}
  private async attachmentEmployeeCosts(claimId:string){if(this.attachmentEmployeeCostsReads?.has(claimId))return this.attachmentEmployeeCostsReads.get(claimId)??[];return this.tx.employeeCompensationCost.findMany({ where: { organizationId: this.organizationId, claimId },
      select:attachmentEmployeeCostsSelect});}
  private async attachmentCompanyCompensationLinks(claimId:string){if(this.attachmentCompanyCompensationLinksReads?.has(claimId))return this.attachmentCompanyCompensationLinksReads.get(claimId)??[];return this.tx.companyExpenseCompensationLink.findMany({ where: { organizationId: this.organizationId, employeeCost: { claimId } },
      select:attachmentCompanyCompensationLinksSelect});}
  private async attachmentResource(id:string){return this.attachmentResourceReads?this.attachmentResourceReads.get(id):(await this.transactionResources([id])).get(id);}
  /** Only a bounded native read snapshot; ordinary command repositories keep fresh lookups. */
  protected async prepareFinancialAttachmentSources(requested:readonly string[]){
    const ids=[...new Set(requested)];if(ids.length>100)throw Error("Bounded financial attachment source read required");this.attachmentJournalReads=undefined;this.attachmentOriginalReads=undefined;this.attachmentReceiptReads=undefined;this.attachmentPropertiesReads=undefined;this.attachmentRecognitionReads=undefined;this.attachmentInvoicesReads=undefined;this.attachmentCompanyLinksReads=undefined;this.attachmentEmployeeCostsReads=undefined;this.attachmentCompanyCompensationLinksReads=undefined;this.attachmentResourceReads=undefined;if(!ids.length)return;
    const journals=await this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,id:{in:ids},sealed:true},select:attachmentJournalSelect}),journalMap=new Map(journals.map(row=>[row.id,row]));this.attachmentJournalReads=new Map(ids.map(id=>[id,journalMap.get(id)??null]));
    const reversalIds=[...new Set(journals.flatMap(row=>row.reversesTransactionId?[row.reversesTransactionId]:[]))],originals=reversalIds.length?await this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,id:{in:reversalIds},sealed:true},select:{id:true,...attachmentOriginalSelect}}):[],originalMap=new Map(originals.map(({id,...original})=>[id,original]));this.attachmentOriginalReads=new Map(reversalIds.map(id=>[id,originalMap.get(id)??null]));
    this.attachmentResourceReads=await super.transactionResources(ids);const originalIds=[...new Set(journals.map(row=>row.reversesTransactionId??row.id))];
    const receipts=await this.tx.cashCollection.findMany({where:{organizationId:this.organizationId,transactionId:{in:originalIds}},select:{transactionId:true,...attachmentReceiptSelect}});this.attachmentReceiptReads=new Map(originalIds.map(id=>[id,[]]));for(const {transactionId,...row}of receipts)if(transactionId)this.attachmentReceiptReads.get(transactionId)?.push(row);
    const recognitions=await this.tx.supplierInvoiceRecognitionLine.findMany({where:{organizationId:this.organizationId,transactionId:{in:originalIds}},select:{transactionId:true,...attachmentRecognitionSelect}});this.attachmentRecognitionReads=new Map(originalIds.map(id=>[id,[]]));for(const {transactionId,...row}of recognitions)this.attachmentRecognitionReads.get(transactionId)?.push(row);
    const dimensionIds=(key:string)=>[...new Set([...journals,...originals].flatMap(row=>row.postings.flatMap(posting=>{const value=posting.dimensions;if(!value||typeof value!=="object"||Array.isArray(value))return[];const id=value[key];return typeof id==="string"&&uuid.test(id)?[id.toLowerCase()]:[];})))];
    const propertyIds=[...new Set([...dimensionIds("property_id"),...receipts.map(row=>row.propertyId)])],properties=propertyIds.length?await this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:propertyIds}},select:attachmentPropertiesSelect,orderBy:{id:"asc"}}):[],propertyMap=new Map(properties.map(row=>[row.id,row]));this.attachmentPropertiesReads=new Map(propertyIds.map(id=>[id,propertyMap.get(id)??null]));
    const invoiceIds=[...new Set([...dimensionIds("supplier_invoice_id"),...recognitions.map(row=>row.invoiceLine.revision.invoiceId)])],invoices=invoiceIds.length?await this.tx.supplierInvoice.findMany({where:{organizationId:this.organizationId,id:{in:invoiceIds}},select:attachmentInvoicesSelect}):[],invoiceMap=new Map(invoices.map(row=>[row.id,row]));this.attachmentInvoicesReads=new Map(invoiceIds.map(id=>[id,invoiceMap.get(id)??null]));
    const companyLinks=invoiceIds.length?await this.tx.companyExpenseInvoiceLink.findMany({where:{organizationId:this.organizationId,invoiceLine:{revision:{invoiceId:{in:invoiceIds}}}},select:{...attachmentCompanyLinksSelect,invoiceLine:{select:{revision:{select:{invoiceId:true}}}}},orderBy:{id:"asc"}}):[];this.attachmentCompanyLinksReads=new Map(invoiceIds.map(id=>[id,[]]));for(const {invoiceLine,...row}of companyLinks)this.attachmentCompanyLinksReads.get(invoiceLine.revision.invoiceId)?.push(row);
    const claimIds=[...new Set([...this.attachmentResourceReads.values()].flatMap(row=>row.compensationRoot?.sourceRecordId?[row.compensationRoot.sourceRecordId]:[]))],costs=claimIds.length?await this.tx.employeeCompensationCost.findMany({where:{organizationId:this.organizationId,claimId:{in:claimIds}},select:{claimId:true,...attachmentEmployeeCostsSelect},orderBy:{id:"asc"}}):[];this.attachmentEmployeeCostsReads=new Map(claimIds.map(id=>[id,[]]));for(const {claimId,...row}of costs)this.attachmentEmployeeCostsReads.get(claimId)?.push(row);
    const companyCompensationLinks=claimIds.length?await this.tx.companyExpenseCompensationLink.findMany({where:{organizationId:this.organizationId,employeeCost:{claimId:{in:claimIds}}},select:{...attachmentCompanyCompensationLinksSelect,employeeCost:{select:{claimId:true}}},orderBy:{id:"asc"}}):[];this.attachmentCompanyCompensationLinksReads=new Map(claimIds.map(id=>[id,[]]));for(const {employeeCost,...row}of companyCompensationLinks)this.attachmentCompanyCompensationLinksReads.get(employeeCost.claimId)?.push(row);
  }

  async source(id: string) {
    const journal = await this.attachmentJournal(id);
    if (!journal || !journal.postings.length) return null;
    const originalId = journal.reversesTransactionId ?? id;
    const original = originalId === id ? journal : await this.attachmentOriginal(originalId);
    if (!original) return null;
    const source = await this.attachmentResource(id); if (!source) return null;
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
    const receipt = await this.attachmentReceipt(originalId);
    if (receipt && !propertyIds.includes(receipt.propertyId)) propertyIds.push(receipt.propertyId);
    if (propertyIds.length === 1) source.propertyId = propertyIds[0];
    const properties = await this.attachmentProperties(propertyIds);
    if (properties.length !== propertyIds.length) return null;
    if (properties.length === 1) { source.city = properties[0].cityId; source.region = properties[0].regionId; }
    const extraChecks: CurrentAuthorityCheck[] = [];
    if (properties.length > 1) { source.propertyId = undefined; source.ownerId = undefined; source.reservationId = undefined;
      extraChecks.push({ action: "view", resource: source, organizationOnly: true }); }
    for (const posting of journal.postings) {
      const wallet = expenseFundingWalletResource(this.organizationId, posting.ledgerAccount, posting.amount.toString(), journal.occurredAt);
      if (wallet) extraChecks.push({ action: "view", resource: wallet });
    }
    const recognition = await this.attachmentRecognition(originalId);
    if (recognition && !invoiceIds.includes(recognition.invoiceLine.revision.invoiceId)) invoiceIds.push(recognition.invoiceLine.revision.invoiceId);
    if (invoiceIds.length) {
      const invoices = await this.attachmentInvoices(invoiceIds);
      if (invoices.length !== invoiceIds.length) return null;
      for (const [type, dataClass] of [["supplier_invoice", "financial"], ["supplier", "personal"]] as const)
        extraChecks.push({ action: "view", resource: { type, organizationId: this.organizationId, dataClass }, organizationOnly: true });
    }
    const companyLinks = invoiceIds.length ? await this.attachmentCompanyLinks(invoiceIds) : [];
    const claimId = source.compensationRoot?.sourceRecordId;
    const employeeCosts = claimId ? await this.attachmentEmployeeCosts(claimId) : [];
    for (const cost of employeeCosts) {
      const original = employeeCompensationCostResource(this.organizationId, cost.submission, cost, { ownerId: null, amount: cost.amount.toString(), status: "APPROVED" }, cost.property);
      extraChecks.push({ action: "view", resource: original, organizationOnly: !cost.propertyId },
        { action: "view", resource: { ...original, occurredAt: journal.occurredAt }, organizationOnly: !cost.propertyId });
    }
    const companyCompensationLinks = claimId ? await this.attachmentCompanyCompensationLinks(claimId) : [];
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
