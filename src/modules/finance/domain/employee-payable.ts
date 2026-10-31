import { employeeCompensationSourceIdentity } from "./employee-compensation-source-identity";
import { Money } from "@/platform/money/money";
import { expensePostings,isExpenseFundingAccount } from "./expense";
import { assertFinancePostingsBalanced,type FinancePostingDraft } from "./reservation-revenue";

type Cost=Omit<Parameters<typeof expensePostings>[0],"fundingAccountId"|"dimensions">;
export type EmployeeClaimPostingLine=Cost&{id:string;runLineId:string;completionEventId:string|null;personId:string;propertyId:string|null;earningKind?:string;assignmentId?:string;earningPeriodKey?:string;taskId?:string|null;reservationId:string|null;category:string;costCenter:string|null};

/** Recognition reuses the configured cost recipe and credits the actual employee claim. */
export function employeeClaimPostings(input:{claimId:string;personId:string;runId:string;liabilityAccountId:string;amount:Money;lines:readonly EmployeeClaimPostingLine[]}):FinancePostingDraft[]{
  if(!input.lines.length||!input.amount.amount.gt(0))throw Error("Employee claim requires positive actual work costs");
  const ids=new Set<string>(),sources=new Set<string>();let total=Money.zero(input.amount.currency);
  const postings=input.lines.flatMap(line=>{
    const monthly=line.earningKind==="PER_MONTH"?employeeCompensationSourceIdentity({...line,taskId:line.taskId??null}):null,key=monthly?.key??line.completionEventId;
    if(!key||line.earningKind!==undefined&&!["PER_JOB","PER_MONTH"].includes(line.earningKind)||ids.has(line.id)||sources.has(key)||!input.personId||line.personId!==input.personId||!monthly&&!line.propertyId||!line.propertyId&&(line.reservationId||line.allocation.ownerAmount.amount.gt(0)||line.allocation.guestAmount.amount.gt(0)))throw Error("Employee claim requires distinct work for its actual beneficiary");
    ids.add(line.id);sources.add(key);total=total.add(line.amount);
    if(line.allocation.guestAmount.amount.gt(0)&&!line.reservationId)throw Error("Guest work costs require their actual reservation");
    const dimensions={employee_person_id:line.personId,employee_compensation_claim_id:input.claimId,employee_compensation_run_id:input.runId,
      employee_compensation_cost_id:line.id,employee_compensation_run_line_id:line.runLineId,...monthly?{employee_compensation_earning_kind:"PER_MONTH",employee_compensation_assignment_id:monthly.assignmentId!,employee_compensation_earning_period:monthly.month!}:{completion_event_id:line.completionEventId!},
      ...(line.propertyId?{property_id:line.propertyId}:{}),...(line.reservationId?{reservation_id:line.reservationId}:{}),category:line.category,...(line.costCenter?{cost_center:line.costCenter}:{}),source:"EMPLOYEE_COMPENSATION"};
    return expensePostings({...line,fundingAccountId:input.liabilityAccountId,dimensions}).map(posting=>posting.ledgerAccountId===input.liabilityAccountId?{...posting,bucket:"EMPLOYEE_COMPENSATION"}:posting);
  });
  if(!total.equals(input.amount))throw Error("Employee source costs must conserve the complete claim");assertFinancePostingsBalanced(postings);return postings;
}

type Settlement={claimId:string;personId:string;settlementId:string;liabilityAccountId:string;amount:Money;outstanding:Money};
function requireOutstanding(input:Settlement){
  if(!input.personId||input.amount.currency!==input.outstanding.currency||!input.amount.amount.gt(0)||!input.outstanding.amount.gt(0)||input.amount.amount.gt(input.outstanding.amount))throw Error("Employee settlement requires positive outstanding money in one currency");
}
/** Payment settles an existing earned claim without recognizing its cost again. */
export function employeePaymentPostings(input:Settlement&{funding:Parameters<typeof isExpenseFundingAccount>[0]&{id:string}}):FinancePostingDraft[]{
  requireOutstanding(input);
  if(!isExpenseFundingAccount(input.funding)||input.funding.id===input.liabilityAccountId||input.funding.teamWallet?.personId===input.personId)throw Error("Employee payment requires a distinct physical source; the beneficiary wallet requires explicit offset");
  const dimensions={employee_person_id:input.personId,employee_compensation_claim_id:input.claimId,employee_compensation_payment_id:input.settlementId,source:"EMPLOYEE_PAYMENT"};
  const postings:FinancePostingDraft[]=[{ledgerAccountId:input.liabilityAccountId,side:"DEBIT",amount:input.amount,bucket:"EMPLOYEE_PAYMENT",dimensions},
    {ledgerAccountId:input.funding.id,side:"CREDIT",amount:input.amount,bucket:"EMPLOYEE_PAYMENT",dimensions}];
  assertFinancePostingsBalanced(postings);return postings;
}

/** Offset is limited by both derived balances and the actual beneficiary's own wallet. */
export function employeeWalletOffsetPostings(input:Settlement&{wallet:Parameters<typeof isExpenseFundingAccount>[0]&{id:string};available:Money}):FinancePostingDraft[]{
  requireOutstanding(input);
  if(input.available.currency!==input.amount.currency||!input.available.amount.gt(0)||input.amount.amount.gt(input.available.amount)||
    !isExpenseFundingAccount(input.wallet)||input.wallet.accountType!=="STAFF_WALLET"||input.wallet.teamWallet?.personId!==input.personId||input.wallet.id===input.liabilityAccountId)
    throw Error("Employee offset requires their actual available wallet balance");
  const dimensions={employee_person_id:input.personId,employee_compensation_claim_id:input.claimId,employee_compensation_offset_id:input.settlementId,
    wallet_person_id:input.personId,source:"EMPLOYEE_COMPENSATION_OFFSET"};
  const postings:FinancePostingDraft[]=[{ledgerAccountId:input.liabilityAccountId,side:"DEBIT",amount:input.amount,bucket:"COMPENSATION_OFFSET",dimensions},
    {ledgerAccountId:input.wallet.id,side:"CREDIT",amount:input.amount,bucket:"COMPENSATION_OFFSET",dimensions}];
  assertFinancePostingsBalanced(postings);return postings;
}
