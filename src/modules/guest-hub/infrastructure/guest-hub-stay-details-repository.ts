import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
export class GuestHubStayDetailsRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockDetails(reservationId:string,guestId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-stay-details:"+this.organizationId+":"+reservationId+":"+guestId},0))`);}
 latestRevision(reservationId:string,guestId:string){return this.tx.guestHubStayDetailsRevision.findFirst({where:{organizationId:this.organizationId,reservationId,guestId},orderBy:{version:"desc"}});}
 revisionByNonce(linkId:string,commandKey:string){return this.tx.guestHubStayDetailsRevision.findFirst({where:{organizationId:this.organizationId,linkId,commandKey}});}
 createRevision(input:Omit<Prisma.GuestHubStayDetailsRevisionUncheckedCreateInput,"organizationId">){return this.tx.guestHubStayDetailsRevision.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_stay_details_birth_guard,guest_profile_event_birth_guard IMMEDIATE`);}
}
