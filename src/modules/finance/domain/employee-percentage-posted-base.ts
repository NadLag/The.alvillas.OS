import {z} from "zod";
import {Money} from "@/platform/money/money";
import {EmployeeCompensationSourceUnavailableError} from "./employee-compensation";
import {employeePercentageEarningsPolicySchema} from "./employee-percentage-earnings";

export type EmployeePercentagePostedSource={
 posting:{id:string;organizationId:string;transactionId:string;ledgerAccountId:string;side:string;amount:{toString():string};currency:string;bucket:string|null};
 transaction:{id:string;organizationId:string;occurredAt:Date;sealed:boolean;reversesTransactionId:string|null;reversedByTransactions:readonly {id:string}[]};
 account:{id:string;organizationId:string};
};

/** Whole original financial authority is calculated once per journal and currency. */
export function employeePostedJournalAmounts(postings:readonly {side:string;currency:string;amount:{toString():string}}[]){
 const totals=new Map<string,Money>();for(const posting of postings)if(posting.side==="DEBIT")totals.set(posting.currency,(totals.get(posting.currency)??Money.zero(posting.currency)).add(Money.of(posting.amount.toString(),posting.currency)));return totals;
}

/** Only an actual sealed, unreversed journal posting can supply a contractual percentage base. */
export function employeePercentagePostedBase(organizationId:string,currency:string,rawPolicy:unknown,source:EmployeePercentagePostedSource){
 const policy=employeePercentageEarningsPolicySchema.parse(rawPolicy),{posting,transaction,account}=source;
 if(![organizationId,posting.id,posting.transactionId,posting.ledgerAccountId,transaction.id,account.id].every(id=>z.uuid().safeParse(id).success)||
  [posting.organizationId,transaction.organizationId,account.organizationId].some(id=>id!==organizationId)||posting.transactionId!==transaction.id||posting.ledgerAccountId!==account.id||
  !transaction.sealed||transaction.reversesTransactionId!==null||transaction.reversedByTransactions.length!==0||!Number.isFinite(transaction.occurredAt.getTime())||
  posting.currency!==currency||posting.side!==policy.base_side||posting.bucket===null||!policy.base_buckets.includes(posting.bucket))throw new EmployeeCompensationSourceUnavailableError();
 let amount:Money;try{amount=Money.of(posting.amount.toString(),currency);}catch{throw new EmployeeCompensationSourceUnavailableError();}
 if(!amount.amount.gt(0))throw new EmployeeCompensationSourceUnavailableError();
 return{postingId:posting.id,transactionId:transaction.id,ledgerAccountId:account.id,occurredAt:transaction.occurredAt,bucket:posting.bucket,side:policy.base_side,amount};
}
