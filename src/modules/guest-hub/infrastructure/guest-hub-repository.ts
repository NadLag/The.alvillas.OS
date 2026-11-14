import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export type GuestHubNativeSource={
 reservationId:string;propertyId:string;guestId:string;reservationStatus:string;bookingSource:string;sourceAvailable:boolean;checkIn:Date;checkOut:Date;timezone:string;
 city:string;region:string;cityId:string|null;regionId:string|null;reference:string;locale:string;reservationCreatedAt:Date;guestCreatedAt:Date;
 reservationVersion:string;reservationTuple:string;reservationNumber:number;propertyVersion:string;propertyTuple:string;guestVersion:string;guestTuple:string;
};
export class GuestHubRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async clock(){const rows=await this.tx.$queryRaw<Array<{now:Date}>>(Prisma.sql`SELECT clock_timestamp() AS now`);return rows[0].now;}
 async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-command:"+this.organizationId+":"+commandKey},0))`);}
 async lockLink(linkId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-link:"+this.organizationId+":"+linkId},0))`);}
 async source(reservationId:string){
  const rows=await this.tx.$queryRaw<GuestHubNativeSource[]>(Prisma.sql`SELECT r.id AS "reservationId",r.property_id AS "propertyId",r.guest_id AS "guestId",r.status AS "reservationStatus",r.source AS "bookingSource",(r.archived_at IS NULL AND p.archived_at IS NULL AND g.archived_at IS NULL AND g.merged_into_id IS NULL) AS "sourceAvailable",r.check_in AS "checkIn",r.check_out AS "checkOut",p.timezone,
   p.city,p.region,p.city_id AS "cityId",p.region_id AS "regionId",r.reference,r.guest_preferred_locale AS locale,r.created_at AS "reservationCreatedAt",g.created_at AS "guestCreatedAt",
   r.xmin::text AS "reservationVersion",r.ctid::text AS "reservationTuple",r.version AS "reservationNumber",p.xmin::text AS "propertyVersion",p.ctid::text AS "propertyTuple",g.xmin::text AS "guestVersion",g.ctid::text AS "guestTuple"
   FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id JOIN guest g ON g.organization_id=r.organization_id AND g.id=r.guest_id
   WHERE r.organization_id=${this.organizationId}::uuid AND r.id=${reservationId}::uuid`);
  return rows[0]??null;
 }
 async lockSources(reservationId:string){
  await this.tx.$queryRaw(Prisma.sql`SELECT r.id FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id JOIN guest g ON g.organization_id=r.organization_id AND g.id=r.guest_id WHERE r.organization_id=${this.organizationId}::uuid AND r.id=${reservationId}::uuid FOR SHARE OF r,p,g`);
 }
 async lockPolicy(policyId:string){await this.tx.$queryRaw(Prisma.sql`SELECT id FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND id=${policyId}::uuid FOR SHARE`);}
 async propertyDimensions(propertyId:string){const rows=await this.tx.$queryRaw<Array<{id:string;city:string;cityId:string|null;region:string;regionId:string|null}>>(Prisma.sql`SELECT id,city,city_id AS "cityId",region,region_id AS "regionId" FROM property WHERE organization_id=${this.organizationId}::uuid AND id=${propertyId}::uuid FOR SHARE`);return rows[0]??null;}
 byId(id:string){return this.tx.guestHubLink.findFirst({where:{organizationId:this.organizationId,id}});}
 byNonce(commandKey:string){return this.tx.guestHubLink.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 revocation(linkId:string){return this.tx.guestHubLinkRevocation.findFirst({where:{organizationId:this.organizationId,linkId}});}
 revocationByNonce(commandKey:string){return this.tx.guestHubLinkRevocation.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 create(input:Omit<Prisma.GuestHubLinkUncheckedCreateInput,"organizationId">){return this.tx.guestHubLink.create({data:{...input,organizationId:this.organizationId}});}
 revoke(input:Omit<Prisma.GuestHubLinkRevocationUncheckedCreateInput,"organizationId">){return this.tx.guestHubLinkRevocation.create({data:{...input,organizationId:this.organizationId}});}
 history(reservationId:string,asOf:Date,before?:{createdAt:Date;id:string}){
  return this.tx.guestHubLink.findMany({where:{organizationId:this.organizationId,reservationId,createdAt:{lte:asOf},...before?{OR:[{createdAt:{lt:before.createdAt}},{createdAt:before.createdAt,id:{lt:before.id}}]}:{}},orderBy:[{createdAt:"desc"},{id:"desc"}],take:26,select:{id:true,createdAt:true,expiresAt:true,createdBy:true,reservationId:true,propertyId:true,guestId:true,revocations:{select:{id:true,createdAt:true}}}});
 }
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_hub_link_birth_guard,guest_hub_revocation_birth_guard,guest_hub_event_birth_guard IMMEDIATE`);}
}
