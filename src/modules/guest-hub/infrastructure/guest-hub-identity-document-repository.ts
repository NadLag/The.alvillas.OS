import type {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class GuestHubIdentityDocumentRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 delegation(grantId:string){return this.tx.guestHubIdentityDocumentDelegation.findFirst({where:{organizationId:this.organizationId,grantId}});}
 appendDelegation(input:Omit<Prisma.GuestHubIdentityDocumentDelegationUncheckedCreateInput,"organizationId">){return this.tx.guestHubIdentityDocumentDelegation.create({data:{...input,organizationId:this.organizationId}});}
}
