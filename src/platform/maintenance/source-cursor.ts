import {documentReadCursor,readDocumentCursor} from "@/modules/documents/application/document-workspace";
import {DocumentConflictError} from "@/modules/documents/domain/document-command";
import {MaintenanceIssueConflictError} from "@/modules/maintenance/domain/issue-context";
import type {AccountActorContext} from "@/platform/authz/session-context";
/** Reuse the native encrypted, actor/organization/filter-bound cursor. */
export const maintenanceSourceCursor=documentReadCursor;
export function readMaintenanceSourceCursor(actor:AccountActorContext,filter:string,cursor?:string){
 try{return readDocumentCursor(actor,filter,cursor);}catch(error){if(error instanceof DocumentConflictError)throw new MaintenanceIssueConflictError();throw error;}
}
