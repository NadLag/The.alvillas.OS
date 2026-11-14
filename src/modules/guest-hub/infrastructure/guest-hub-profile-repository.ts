import {GuestHubFormGrantRepository} from "./guest-hub-form-grant-repository";
import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class GuestHubProfileRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockProfile(reservationId:string,guestId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-profile:"+this.organizationId+":"+reservationId+":"+guestId},0))`);}
 grantHead(linkId:string){return new GuestHubFormGrantRepository(this.tx,this.organizationId,"PROFILE").grantHead(linkId);}
 grantByNonce(commandKey:string){return new GuestHubFormGrantRepository(this.tx,this.organizationId,"PROFILE").grantByNonce(commandKey);}
 grantById(id:string){return new GuestHubFormGrantRepository(this.tx,this.organizationId,"PROFILE").grantById(id);}
 createGrant(input:Omit<Prisma.GuestHubFormGrantUncheckedCreateInput,"organizationId">){return new GuestHubFormGrantRepository(this.tx,this.organizationId,"PROFILE").createGrant(input);}
 latestRevision(reservationId:string,guestId:string){return this.tx.guestHubProfileRevision.findFirst({where:{organizationId:this.organizationId,reservationId,guestId},orderBy:{version:"desc"}});}
 revisionByNonce(linkId:string,commandKey:string){return this.tx.guestHubProfileRevision.findFirst({where:{organizationId:this.organizationId,linkId,commandKey}});}
 createRevision(input:Omit<Prisma.GuestHubProfileRevisionUncheckedCreateInput,"organizationId">){return this.tx.guestHubProfileRevision.create({data:{...input,organizationId:this.organizationId}});}
 async canonicalValues(reservationId:string,guestId:string){
  const rows=await this.tx.$queryRaw<Array<{displayName:string;email:string|null;phone:string|null;preferredLocale:string}>>(Prisma.sql`SELECT g.display_name AS "displayName",g.email,g.phone,r.guest_preferred_locale AS "preferredLocale" FROM reservation r JOIN guest g ON g.organization_id=r.organization_id AND g.id=r.guest_id WHERE r.organization_id=${this.organizationId}::uuid AND r.id=${reservationId}::uuid AND g.id=${guestId}::uuid AND r.archived_at IS NULL AND g.archived_at IS NULL AND g.merged_into_id IS NULL`);
  return rows[0]??null;
 }
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_form_grant_birth_guard,guest_profile_birth_guard,guest_profile_event_birth_guard IMMEDIATE`);}
}
