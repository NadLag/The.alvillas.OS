import {z} from "zod";
import {Money} from "@/platform/money/money";
import {EmployeeCompensationRunAccessError} from "./employee-compensation-run";
import {employeePercentageEarnedAmount} from "./employee-percentage-earnings";
type Amount={toString():string};
type Source={personId:string;currency:string;amount:Amount;sourceSnapshot:unknown;percentageWitnesses:readonly{
 isEarningBase:boolean;posting:{id:string;amount:Amount;currency:string;bucket:string|null;side:string;transaction:{id:string;reference:string;occurredAt:Date}};
 compensation:{id:string;version:number;amount:Amount;currency:string;assignment:{personId:string}};configRule:{id:string;version:number};policyRule:{id:string;version:number}
 }[]};
const snapshot=z.object({kind:z.literal("ACTUAL_POSTED_PERCENTAGE_EARNINGS"),earningPolicyRuleId:z.uuid(),earningPolicyVersion:z.number().int().positive(),earningPolicy:z.unknown()});

/** Retained actual postings and contracts explain original earnings without repricing later history. */
export function employeePercentageSourceEvidence(source:Source){
 const captured=snapshot.safeParse(source.sourceSnapshot),bases=source.percentageWitnesses.filter(row=>row.isEarningBase);
 if(!captured.success||!bases.length||new Set(bases.map(row=>row.posting.id)).size!==bases.length||bases.some(row=>row.compensation.assignment.personId!==source.personId||row.compensation.currency!==source.currency||row.policyRule.id!==captured.data.earningPolicyRuleId||row.policyRule.version!==captured.data.earningPolicyVersion||row.posting.bucket===null||!["DEBIT","CREDIT"].includes(row.posting.side)))throw new EmployeeCompensationRunAccessError();
 const originals=bases.map(row=>({postingId:row.posting.id,transactionId:row.posting.transaction.id,bucket:row.posting.bucket!,side:row.posting.side as "DEBIT"|"CREDIT",amount:Money.of(row.posting.amount.toString(),row.posting.currency),rate:Money.of(row.compensation.amount.toString(),row.compensation.currency)})),earned=employeePercentageEarnedAmount(captured.data.earningPolicy,source.currency,originals);
 if(!earned.amount.equals(Money.of(source.amount.toString(),source.currency)))throw new EmployeeCompensationRunAccessError();
 return{baseAmount:earned.baseAmount.toJSON(),amount:earned.amount.toJSON(),baseCount:bases.length,journalCount:new Set(bases.map(row=>row.posting.transaction.id)).size,
  sources:bases.map(row=>({postingId:row.posting.id,transactionId:row.posting.transaction.id,reference:row.posting.transaction.reference,occurredAt:row.posting.transaction.occurredAt.toISOString(),amount:Money.of(row.posting.amount.toString(),row.posting.currency).toJSON(),rate:Money.of(row.compensation.amount.toString(),row.compensation.currency).toJSON(),contractVersion:row.compensation.version}))};
}
