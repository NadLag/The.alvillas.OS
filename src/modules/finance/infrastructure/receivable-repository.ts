import {Prisma} from "@prisma/client";
import {LedgerCalendarRepository} from "./ledger-calendar-repository";
import {receivablePolicySchema,ReceivablePolicyError,type ReceivableAccountTotals} from "../domain/receivable";

export class ReceivableRepository extends LedgerCalendarRepository{
  async assertConfiguredAccounts(policy:unknown){
    const config=receivablePolicySchema.parse(policy),accounts=await this.tx.ledgerAccount.findMany({where:{organizationId:this.organizationId,code:{in:config.account_codes}},
      select:{id:true,accountType:true,normalSide:true}});
    if(accounts.length!==config.account_codes.length||accounts.some(row=>row.accountType!=="CLAIM_OWNERSHIP"||row.normalSide!=="DEBIT"))
      throw new ReceivablePolicyError("Configured receivable ownership accounts are unavailable");
    return config;
  }
  /** Uses original postings only; a reservation's current guest never changes a historical claim. */
  async accountTotals(policy:unknown,input:{startsAt:Date;endsAt:Date;currency:string}){
    const config=receivablePolicySchema.parse(policy);
    if(!Number.isFinite(input.startsAt.getTime())||!Number.isFinite(input.endsAt.getTime())||input.startsAt>=input.endsAt)
      throw Error("Receivable movement range is invalid");
    await this.assertConfiguredAccounts(config);
    return this.tx.$queryRaw<ReceivableAccountTotals[]>(Prisma.sql`
      SELECT a.id::text,a.code,a.name,a.account_type AS "accountType",a.normal_side AS "normalSide",${input.currency}::text AS currency,
        COALESCE(SUM(CASE WHEN t.occurred_at<${input.startsAt} THEN CASE WHEN p.side='DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS opening,
        COALESCE(SUM(p.amount) FILTER(WHERE t.occurred_at>=${input.startsAt} AND p.side='DEBIT'),0)::text AS debits,
        COALESCE(SUM(p.amount) FILTER(WHERE t.occurred_at>=${input.startsAt} AND p.side='CREDIT'),0)::text AS credits,
        COUNT(p.id) FILTER(WHERE t.occurred_at>=${input.startsAt})::text AS count
      FROM ledger_account a
      LEFT JOIN (posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id)
        ON p.organization_id=a.organization_id AND p.ledger_account_id=a.id AND p.currency=${input.currency} AND t.occurred_at<${input.endsAt}
      WHERE a.organization_id=${this.organizationId}::uuid AND a.code IN(${Prisma.join(config.account_codes)})
        AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='DEBIT'
      GROUP BY a.id,a.code,a.name,a.account_type,a.normal_side ORDER BY a.code,a.id`);
  }
}
