import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

/** Append-only links to canonical archive facts; this aggregate never stores file bytes. */
export class GuestHubIdentityArchiveRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 admission(fileId:string){return this.tx.guestHubIdentityDocumentAdmission.findUnique({where:{organizationId_fileId:{organizationId:this.organizationId,fileId}},include:{publication:true}});}
 publication(fileId:string){return this.tx.guestHubIdentityDocumentPublication.findUnique({where:{organizationId_fileId:{organizationId:this.organizationId,fileId}}});}
 publishedCaptureFiles(captureId: string) {
  return this.tx.guestHubIdentityDocumentPublication.findMany({
   where: { organizationId: this.organizationId, original: { file: { captureId }, document: { archivedAt: null } } },
   select: { fileId: true }
  });
 }
 appendAdmission(input:Omit<Prisma.GuestHubIdentityDocumentAdmissionUncheckedCreateInput,"organizationId"|"publication">){return this.tx.guestHubIdentityDocumentAdmission.create({data:{...input,organizationId:this.organizationId}});}
 appendPublication(input:Omit<Prisma.GuestHubIdentityDocumentPublicationUncheckedCreateInput,"organizationId">){return this.tx.guestHubIdentityDocumentPublication.create({data:{...input,organizationId:this.organizationId}});}
 async validateAdmissionBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_identity_admission_birth_guard,guest_identity_canonical_admission_birth_guard,guest_identity_archive_event_birth_guard IMMEDIATE`);}
 async validatePublicationBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_identity_publication_birth_guard,guest_identity_canonical_version_birth_guard,guest_identity_archive_event_birth_guard IMMEDIATE`);}
}
