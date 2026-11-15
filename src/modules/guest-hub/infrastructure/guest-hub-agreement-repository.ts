import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class GuestHubAgreementRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 releaseHead(linkId:string){return this.tx.guestHubAgreementRelease.findFirst({where:{organizationId:this.organizationId,linkId},orderBy:{version:"desc"}});}
 release(id:string){return this.tx.guestHubAgreementRelease.findFirst({where:{organizationId:this.organizationId,id}});}
 releaseByNonce(actorId:string,commandKey:string){return this.tx.guestHubAgreementRelease.findFirst({where:{organizationId:this.organizationId,createdBy:actorId,commandKey}});}
 createRelease(input:Omit<Prisma.GuestHubAgreementReleaseUncheckedCreateInput,"organizationId">){return this.tx.guestHubAgreementRelease.create({data:{...input,organizationId:this.organizationId}});}
 request(id:string){return this.tx.guestHubAgreementRequest.findFirst({where:{organizationId:this.organizationId,id}});}
 requestByNonce(linkId:string,commandKey:string){return this.tx.guestHubAgreementRequest.findFirst({where:{organizationId:this.organizationId,linkId,commandKey}});}
 requestForPreparation(preparationId:string){return this.tx.guestHubAgreementRequest.findFirst({where:{organizationId:this.organizationId,preparationId}});}
 history(linkId:string,asOf:Date,before?:{id:string;createdAt:Date}){return this.tx.guestHubAgreementRequest.findMany({where:{organizationId:this.organizationId,linkId,createdAt:{lte:asOf},...before?{OR:[{createdAt:{lt:before.createdAt}},{createdAt:before.createdAt,id:{lt:before.id}}]}:{}},orderBy:[{createdAt:"desc"},{id:"desc"}],take:26});}
 async lockPreparation(preparationId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-agreement:"+this.organizationId+":"+preparationId},0))`);}
 createRequest(input:Omit<Prisma.GuestHubAgreementRequestUncheckedCreateInput,"organizationId">){return this.tx.guestHubAgreementRequest.create({data:{...input,organizationId:this.organizationId}});}
 documentOrigin(guestRequestId:string){return this.tx.guestHubAgreementDocumentOrigin.findFirst({where:{organizationId:this.organizationId,guestRequestId}});}
 createDocumentOrigin(input:Omit<Prisma.GuestHubAgreementDocumentOriginUncheckedCreateInput,"organizationId">){return this.tx.guestHubAgreementDocumentOrigin.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_agreement_release_birth_guard,guest_agreement_request_birth_guard,guest_agreement_event_birth_guard IMMEDIATE`);}
}
