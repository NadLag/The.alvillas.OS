import {createHash} from "node:crypto";
import {downloadDocumentVersion} from "@/modules/documents/application/document-archive";
import type {DocumentObjectStore} from "@/modules/documents/application/document-files";
import {createGuestHubAgreementFileLease} from "@/modules/guest-hub/application/guest-hub-agreement-files";
import type {GuestHubAgreementVisitDependencies} from "@/modules/guest-hub/application/guest-hub-agreement-requests";
import {GuestHubAgreementAccessError} from "@/modules/guest-hub/domain/guest-hub-agreement-policy";

/** Canonical download validates its archive and held/current document grants.
 * Guest authority is fenced again before any byte can reach the response. */
export async function downloadNativeGuestAgreement(capability:unknown,input:unknown,deps:GuestHubAgreementVisitDependencies&{objects:DocumentObjectStore}){
 const lease=await createGuestHubAgreementFileLease(capability,input,deps),initial=await lease.inspect(),file=await downloadDocumentVersion(initial.actor,{versionId:initial.versionId},deps);
 try{
  const final=await lease.recordRead();if(final.versionId!==initial.versionId||file.contentType!=="application/pdf"||initial.kind==="ORIGINAL"&&createHash("sha256").update(file.bytes).digest("hex")!==initial.original.document.sha256)throw new GuestHubAgreementAccessError();return file;
 }catch(error){file.bytes.fill(0);throw error;}
}
