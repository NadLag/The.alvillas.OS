import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

const context={package:{select:{id:true,sessionId:true,reviewRevisionId:true,ownerId:true,propertyId:true,createdBy:true}}}as const;
export class OnboardingOwnerDeliveryRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 byId(id:string){return this.tx.ownerOnboardingDelivery.findFirst({where:{organizationId:this.organizationId,id},include:context});}
 byNonce(commandKey:string){return this.tx.ownerOnboardingDelivery.findFirst({where:{organizationId:this.organizationId,commandKey},include:context});}
 create(input:Omit<Prisma.OwnerOnboardingDeliveryUncheckedCreateInput,"organizationId">){return this.tx.ownerOnboardingDelivery.create({data:{...input,organizationId:this.organizationId},include:context});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS owner_delivery_birth_guard IMMEDIATE`);}
}
