import type { Resource } from "@/platform/authz/authorize";
import { employeeCompensationSettlementAuditSchema } from "@/modules/finance/domain/employee-compensation-settlement";
import { expenseFundingWalletResource } from "@/modules/finance/domain/expense";
type Funding=Parameters<typeof expenseFundingWalletResource>[1]&{id:string};

/** The public ledger boundary exposes actual disclosure sources, never authority from an audit payload. */
export function employeeSettlementAuditSources(input:{organizationId:string;claimId:string;originalJournalId:string;postedAt:Date;receipt:unknown;accounts:readonly Funding[]}){
  const parsed=employeeCompensationSettlementAuditSchema.safeParse(input.receipt),financialSources:Resource[]=[],walletSources:Resource[]=[];
  if(!parsed.success||parsed.data.input.claimId!==input.claimId||parsed.data.transactionId!==input.originalJournalId)return{bound:false,financialSources,walletSources};
  const saved=parsed.data,funding=input.accounts.find(account=>account.id===saved.input.fundingAccountId);if(!funding)return{bound:false,financialSources,walletSources};
  for(const at of[new Date(saved.input.paidAt),input.postedAt]){financialSources.push({type:"financial_transaction",organizationId:input.organizationId,id:funding.id,financialRecordId:funding.id,dataClass:"financial",amount:saved.input.amount,occurredAt:at});const wallet=expenseFundingWalletResource(input.organizationId,funding,saved.input.amount,at);if(wallet)walletSources.push(wallet);}
  return{bound:true,financialSources,walletSources};
}
