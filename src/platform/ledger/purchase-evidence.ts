import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentArchiveContext} from "@/modules/documents/application/document-archive";
/** Reuse the private archive and its original source/financial authority. */
export async function inspectPurchaseReceipt(actor:AccountActorContext,tx:TenantTransaction,input:{propertyId:string;reservationId?:string|null;receiptVersionId:string},historical=false){
 const repository=new DocumentRepository(tx,actor.organizationId),version=await repository.version(input.receiptVersionId),root=version?await repository.document(version.documentId):null;
 if(!version||!root||root.kind!=="FILE"||!root.privacy.includes("financial")||!historical&&(root.archivedAt||version.next.length)||!['application/pdf','image/jpeg','image/png','image/webp'].includes(version.admission.contentType)||!(root.sourceKind==="PROPERTY"&&root.sourceId===input.propertyId||root.sourceKind==="RESERVATION"&&root.sourceId===input.reservationId))throw Error("Original private purchase receipt required");
 const kind=root.sourceKind==="PROPERTY"?"PROPERTY":"RESERVATION";
 const source=await documentArchiveContext(actor,tx,{kind,id:root.sourceId},"view",root);
 return{version,root,fingerprint:source.fingerprint};
}
