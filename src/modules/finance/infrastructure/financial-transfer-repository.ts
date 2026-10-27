import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export class FinancialTransferRepository {
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lock(key:string){
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":financial-transfer:"+key},0))::text`);
  }
  async lockAccounts(ids:string[]){
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM ledger_account WHERE organization_id=${this.organizationId}::uuid
      AND id IN (${Prisma.join([...new Set(ids)].sort().map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`);
  }
  currency(code:string){return this.tx.currency.findUnique({where:{code},select:{code:true,minorUnit:true}})}
  async currencyChoices(){
    const [organization,currencies]=await Promise.all([this.tx.organization.findUniqueOrThrow({where:{id:this.organizationId},select:{baseCurrency:true}}),
      this.tx.currency.findMany({where:{minorUnit:{lte:2}},orderBy:{code:"asc"},select:{code:true,minorUnit:true}})]);
    return{baseCurrency:organization.baseCurrency,currencies};
  }
  postedAudit(id:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:id,action:"finance.transfer.posted"},orderBy:{createdAt:"asc"}})}
  list(after?:string){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,reference:{startsWith:"TRANSFER:"},reversesTransactionId:null,
    ...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:51,include:{postings:{include:{ledgerAccount:{select:{id:true,code:true,name:true,accountType:true,normalSide:true,archivedAt:true,
      teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}}}},reversedByTransactions:true}})}
  journal(id:string){return this.tx.financialTransaction.findFirst({where:{organizationId:this.organizationId,id},include:{postings:true,reversedByTransactions:true}})}
}
