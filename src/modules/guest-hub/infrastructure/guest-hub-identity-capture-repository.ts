import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {guestHubIdentityDocumentManifestSchema} from "../domain/guest-hub-identity-document-private-contract";

export class GuestHubIdentityCaptureRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockCaptures(reservationId:string,guestId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-identity-documents:"+this.organizationId+":"+reservationId+":"+guestId},0))`);}
 latestCapture(reservationId:string,guestId:string){return this.tx.guestHubIdentityDocumentCapture.findFirst({where:{organizationId:this.organizationId,reservationId,guestId},orderBy:{version:"desc"}});}
 captureByNonce(linkId:string,commandKey:string){return this.tx.guestHubIdentityDocumentCapture.findFirst({where:{organizationId:this.organizationId,linkId,commandKey}});}
 captureById(linkId:string,id:string){return this.tx.guestHubIdentityDocumentCapture.findFirst({where:{organizationId:this.organizationId,linkId,id}});}
 fileById(captureId:string,id:string){return this.tx.guestHubIdentityDocumentFile.findFirst({where:{organizationId:this.organizationId,captureId,id}});}
 async createCapture(input:Omit<Prisma.GuestHubIdentityDocumentCaptureUncheckedCreateInput,"organizationId"|"files">){
  const manifest=guestHubIdentityDocumentManifestSchema.parse(input.fileManifest),saved=await this.tx.guestHubIdentityDocumentCapture.create({data:{...input,organizationId:this.organizationId}});
  await this.tx.guestHubIdentityDocumentFile.createMany({data:manifest.map(file=>({...file,organizationId:this.organizationId,captureId:saved.id,createdAt:saved.createdAt}))});
  return saved;
 }
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_identity_capture_birth_guard,guest_identity_capture_event_birth_guard IMMEDIATE`);}
}
