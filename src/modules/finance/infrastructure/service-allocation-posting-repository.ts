import type {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

const include={source:true,admission:true,transaction:{include:{postings:{include:{ledgerAccount:true}},reversedByTransactions:true}},reversedByPosting:true,periodAdjustment:true} satisfies Prisma.ServiceAllocationPostingInclude;

/** Journal acknowledgements contain no stored balance or duplicate provider obligation. */
export class ServiceAllocationPostingRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 byNonce(idempotencyKey:string){return this.tx.serviceAllocationPosting.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include});}
 posting(id:string){return this.tx.serviceAllocationPosting.findUnique({where:{organizationId_id:{organizationId:this.organizationId,id}},include});}
 latest(sourceId:string){return this.tx.serviceAllocationPosting.findFirst({where:{organizationId:this.organizationId,sourceId},orderBy:{version:"desc"},include});}
 activeRecognition(sourceId:string){return this.tx.serviceAllocationPosting.findFirst({where:{organizationId:this.organizationId,sourceId,kind:"RECOGNITION",reversedByPosting:null},orderBy:{version:"desc"},include});}
 append(data:Omit<Prisma.ServiceAllocationPostingUncheckedCreateInput,"organizationId">){return this.tx.serviceAllocationPosting.create({data:{...data,organizationId:this.organizationId}});}
 history(sourceId:string,beforeVersion?:number){return this.tx.serviceAllocationPosting.findMany({where:{organizationId:this.organizationId,sourceId,...beforeVersion?{version:{lt:beforeVersion}}:{}},orderBy:{version:"desc"},take:51,include});}
}
