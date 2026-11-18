import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {SupplierInvoiceRepository} from "@/modules/finance/infrastructure/supplier-invoice-repository";
import {assertSupplierInvoiceAuthority,SupplierInvoiceAccessError,SupplierInvoiceConflictError} from "@/modules/finance/application/supplier-invoice-access";
import {getSupplierInvoice} from "@/modules/finance/application/supplier-invoice-service";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentArchiveContext} from "@/modules/documents/application/document-archive";
import {DocumentAccessError,DocumentConflictError,documentSourceReferenceSchema} from "@/modules/documents/domain/document-command";
import {actualLaundryInvoiceSelectionSchema,selectActualLaundryInvoiceLines} from "@/modules/inventory/domain/actual-laundry-invoice";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
/** Reuse original invoice entry/approval and encrypted document upload. This
 * bridge only proves their current identity; it never posts or pays a cost. */
export async function inspectActualLaundryInvoiceSource(actor:AccountActorContext,tx:TenantTransaction,raw:unknown,context:{supplierId:string;propertyIds:readonly string[];reservationIds:readonly string[]},historical=false){
 const selection=actualLaundryInvoiceSelectionSchema.parse(raw),invoices=new SupplierInvoiceRepository(tx,actor.organizationId),documents=new DocumentRepository(tx,actor.organizationId),finance=new FinanceRepository(tx,actor.organizationId),runner={$transaction:async<T>(work:(tx:TenantTransaction)=>Promise<T>)=>work(tx)};
 async function read(){try{
  await assertSupplierInvoiceAuthority(actor,tx,"view",await finance.clock());const invoice=await invoices.find(selection.invoiceId);if(!invoice||invoice.supplierId!==context.supplierId||!historical&&(invoice.archivedAt||invoice.currentRevisionId!==selection.revisionId))throw new InventoryCatalogAccessError();
  await getSupplierInvoice(actor,invoice.id,{revisionId:selection.revisionId},{db:runner});const revision=await invoices.revision(invoice.id,selection.revisionId);if(!revision)throw new InventoryCatalogAccessError();const selected=revision.lines.filter(line=>selection.lineIds.includes(line.id));if(selected.length!==selection.lineIds.length)throw new InventoryCatalogAccessError();const actual=selectActualLaundryInvoiceLines(selected.map(line=>({id:line.id,propertyId:line.propertyId,reservationId:line.reservationId,category:line.category,costCenter:line.costCenter,amount:line.amount.toFixed(2)})),selection,{...context,currency:revision.currency});
  const version=await documents.version(selection.receiptVersionId),root=version?await documents.document(version.documentId):null;if(!version||!root||root.kind!=="FILE"||!root.privacy.includes("financial")||!historical&&(root.archivedAt||version.next.length)||!["application/pdf","image/jpeg","image/png"].includes(version.admission.contentType))throw new InventoryCatalogAccessError();
  if(!(root.sourceKind==="SUPPLIER"&&root.sourceId===context.supplierId||root.sourceKind==="PROPERTY"&&context.propertyIds.includes(root.sourceId)||root.sourceKind==="RESERVATION"&&context.reservationIds.includes(root.sourceId)))throw new InventoryCatalogAccessError();const reference=documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),archive=await documentArchiveContext(actor,tx,reference,"view",root),source={invoice:{id:invoice.id,version:invoice.version,state:invoice.state,archived:invoice.archivedAt!==null,supplierId:invoice.supplierId,reference:invoice.reference,invoiceNumber:revision.invoiceNumber,revisionId:revision.id,revisionVersion:revision.version,issuedOn:revision.issuedOn.toISOString().slice(0,10)},...actual,receipt:{versionId:version.id,documentId:root.id,source:reference,title:version.title,sha256:version.admission.sha256,contentType:version.admission.contentType}};
  await assertSupplierInvoiceAuthority(actor,tx,"view",await finance.clock());await recheckAccountAuthorization(actor,tx,await finance.clock(),archive.checks,new InventoryCatalogAccessError());return{...source,fingerprint:jsonbFingerprint({source,archive:archive.fingerprint})};
 }catch(error){if(error instanceof SupplierInvoiceAccessError||error instanceof DocumentAccessError)throw new InventoryCatalogAccessError();if(error instanceof SupplierInvoiceConflictError||error instanceof DocumentConflictError)throw new InventoryCatalogConflictError();throw error;}}
 const initial=await read();return{...initial,recheck:async()=>{const latest=await read();if(latest.fingerprint!==initial.fingerprint)throw new InventoryCatalogConflictError();return latest;}};
}
