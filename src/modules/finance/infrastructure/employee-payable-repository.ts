import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";

/** Earned, paid and offset amounts are always derived from their immutable actual journals. */
export class EmployeePayableRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-settlement:"+key},0))::text`);}
  journals(claimId:string){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,postings:{some:{dimensions:{path:["employee_compensation_claim_id"],equals:claimId}}}},orderBy:{id:"asc"},
    include:{postings:{include:{ledgerAccount:{select:{id:true,code:true,name:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}}}},reversedByTransactions:true}});}
  audits(ids:readonly string[]){return this.tx.auditLog.findMany({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:{in:[...ids]},action:"finance.employee_settlement.posted"},orderBy:{id:"asc"},select:{id:true,resourceId:true,actorId:true,reason:true,after:true}});}
  reversalAudit(paymentId:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:paymentId,action:"finance.employee_settlement.reversed"},orderBy:{id:"asc"}});}
  async outstanding(input:{claimId:string;personId:string;currency:string}):Promise<Money>{
    const[row]=await this.tx.$queryRaw<Array<{amount:Prisma.Decimal}>>(Prisma.sql`SELECT COALESCE(SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) AS amount
      FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency} AND a.code='EMPLOYEE_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT'
       AND p.dimensions->>'employee_compensation_claim_id'=${input.claimId} AND p.dimensions->>'employee_person_id'=${input.personId}`);
    return Money.of(row.amount.toString(),input.currency);
  }
}
