import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class GuestHubHouseRulesRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async canonicalRules(propertyId:string){const rows=await this.tx.$queryRaw<Array<{rules:Prisma.JsonValue}>>(Prisma.sql`SELECT house_rules AS rules FROM property_onboarding_profile WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid FOR SHARE`);return rows[0]??null;}
 async lockAcceptances(reservationId:string,guestId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"guest-hub-house-rules:"+this.organizationId+":"+reservationId+":"+guestId},0))`);}
 latestAcceptance(reservationId:string,guestId:string){return this.tx.guestHubHouseRulesAcceptance.findFirst({where:{organizationId:this.organizationId,reservationId,guestId},orderBy:{version:"desc"}});}
 acceptanceForEdition(reservationId:string,guestId:string,editionFingerprint:string){return this.tx.guestHubHouseRulesAcceptance.findFirst({where:{organizationId:this.organizationId,reservationId,guestId,editionFingerprint}});}
 acceptanceByNonce(linkId:string,commandKey:string){return this.tx.guestHubHouseRulesAcceptance.findFirst({where:{organizationId:this.organizationId,linkId,commandKey}});}
 createAcceptance(input:Omit<Prisma.GuestHubHouseRulesAcceptanceUncheckedCreateInput,"organizationId">){return this.tx.guestHubHouseRulesAcceptance.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_house_rules_birth_guard,guest_house_rules_event_birth_guard IMMEDIATE`);}
}
