import type {DocumentAdmission,DocumentVersion} from "@prisma/client";
import type {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {DocumentActorContext} from "./document-archive";
import type {NativeGuestIdentityRetentionReservation} from "./document-retention-service";
import type {nativeGuestIdentityDocumentProvenanceSchema} from "../domain/document-guest-identity-upload";

/** Implemented only by the native application composition with its budgeted,
 * request-scoped file lease. Public upload commands cannot supply this authority. */
export type NativeGuestIdentityArchiveBoundary={
 access:"UPLOAD"|"STATUS";
 documentId:string;
 privacy:readonly string[];
 provenance:z.infer<typeof nativeGuestIdentityDocumentProvenanceSchema>;
 prepareAdmission(actor:DocumentActorContext,tx:TenantTransaction,input:unknown):Promise<void>;
 recordAdmission(actor:DocumentActorContext,tx:TenantTransaction,admission:DocumentAdmission):Promise<void>;
 assertAdmission(actor:DocumentActorContext,tx:TenantTransaction,admission:DocumentAdmission):Promise<void>;
 reserveRetention(actor:DocumentActorContext,tx:TenantTransaction,admission:DocumentAdmission):Promise<NativeGuestIdentityRetentionReservation>;
 publishVersion(actor:DocumentActorContext,tx:TenantTransaction,admission:DocumentAdmission,version:DocumentVersion,reservation:NativeGuestIdentityRetentionReservation):Promise<void>;
};
