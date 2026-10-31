import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { readWalletLedger } from "@/platform/ledger/wallet-lock";
import { localClockInstant,localClockLabel } from "@/platform/time/local-instant";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import type { FinanceLedgerAccount } from "../infrastructure/finance-repository";
import { employeeCompensationPaymentWorkspaceInput,employeeCompensationPaymentWorkspaceSchema } from "../domain/employee-compensation-payment-workspace";
import { employeeCompensationSettlementInput } from "../domain/employee-compensation-settlement";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { isExpenseFundingAccount } from "../domain/expense";
import { prepareEmployeeCompensationSettlement,employeeSettlementPaymentResource,employeeSettlementFundingChecks,employeeSettlementVoidChecks } from "./employee-compensation-settlement";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import type { recheckFinanceAuthorization,FinanceActorContext } from "./finance-access";
type Check=Parameters<typeof recheckFinanceAuthorization>[3][number];
type Source=Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>;
const stableJournals=(rows:Source["journals"])=>JSON.stringify([...rows].sort((a,b)=>a.id.localeCompare(b.id)).map(row=>({...row,postings:[...row.postings].sort((a,b)=>a.id.localeCompare(b.id)),reversedByTransactions:[...row.reversedByTransactions].sort((a,b)=>a.id.localeCompare(b.id))})));

/** Complete current source authority precedes balances, independently authorized funding choices and history. */
export async function getEmployeeCompensationPaymentWorkspace(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=employeeCompensationPaymentWorkspaceInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const source=await prepareEmployeeCompensationSettlement(ctx,input.id,input.claimId,tx,"view"),finance=source.finance,now=await finance.clock(),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),allows=(checks:readonly Check[])=>checks.every(check=>[ctx.authContext,current].every(auth=>check.organizationOnly?authorizeOrganizationSource(auth,check.action,check.resource,now):authorize(auth,check.action,check.resource,now)));
    const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),rows=await runs.displayLines(source.row.runId,[source.retained.costs[0].runLineId]),metadata=await employeeCompensationSourceLabels(ctx,tx,rows,[]);if(rows.length!==1)throw new EmployeeCompensationRunAccessError();const disclosure:Check[]=metadata.checks.filter(check=>check.resource.type==="identity");
    const outstanding=await source.payables.outstanding({claimId:input.claimId,personId:source.retained.personId,currency:source.retained.amount.currency}),currency=await source.claims.currency(source.retained.amount.currency);if(!currency||outstanding.amount.lt(0))throw new ExpensePolicyUnavailableError();
    const calendar=await source.periods.policy(now),sourcePay=allows(source.sourceActionChecks("pay")),sourceVoid=allows(source.sourceActionChecks("void")),claimReversed=source.journals.some(journal=>source.existing!.lines.some(line=>line.transactionId===journal.id)&&journal.reversedByTransactions.length>0);
    const blocked=!calendar?"calendar_unavailable":claimReversed?"source_reversed":!outstanding.amount.gt(0)?"no_outstanding":!sourcePay?"posting_forbidden":null,canPrepare=blocked===null;
    const parsedAmount=employeeCompensationSettlementInput.shape.amount.safeParse(input.amount??outstanding.toJSON().amount),amount=parsedAmount.success?Money.of(parsedAmount.data,currency.code):null;
    const paidLocal=input.paidLocal??(calendar?localClockLabel(now.toISOString(),calendar.value.timezone):null);let paidAt:Date|null=null,error:"clock"|"future"|"amount"|"closed"|"forbidden"|"wallet_unavailable"|null=null;
    if(calendar&&paidLocal)try{paidAt=new Date(localClockInstant(paidLocal,calendar.value.timezone,input.occurrence));}catch(errorValue){if(!(errorValue instanceof RangeError))throw errorValue;error="clock";}
    if(canPrepare&&!amount)error="amount";
    const target=amount&&paidAt?employeeSettlementPaymentResource(ctx,source,amount.toJSON().amount,paidAt):null,dateChecks:Check[]=target?[{action:"view",resource:target,organizationOnly:!target.propertyId}]:[],dateView=Boolean(target&&allows(dateChecks)),closed=Boolean(dateView&&paidAt&&!await source.periods.postingOpen(paidAt)),postingAt=closed?now:paidAt;
    const actionChecks:Check[]=target&&postingAt?[...source.sourceActionChecks("pay"),...dateChecks,{action:"pay",resource:target,organizationOnly:!target.propertyId},{action:"create",resource:{...target,occurredAt:postingAt},organizationOnly:!target.propertyId},...(closed?[{action:"override" as const,resource:target,organizationOnly:!target.propertyId}]:[])]:[];
    const canAdjust=Boolean(target&&allows([{action:"override",resource:target,organizationOnly:!target.propertyId}]));
    let canPay=Boolean(canPrepare&&amount&&paidAt&&postingAt&&paidAt<=now&&dateView&&amount.amount.decimalPlaces()<=currency.minorUnit&&!amount.amount.gt(outstanding.amount)&&allows(actionChecks)&&(!closed||await source.periods.postingOpen(now)));
    if(canPrepare&&amount&&paidAt){if(paidAt>now)error="future";else if(amount.amount.gt(outstanding.amount)||amount.amount.decimalPlaces()>currency.minorUnit)error="amount";else if(!dateView||!allows(actionChecks))error="forbidden";else if(closed&&!await source.periods.postingOpen(now))error="closed";}
    const accounts:FinanceLedgerAccount[]=[];let fundingNext:string|null=null,walletAvailable:ReturnType<Money["toJSON"]>|null=null;
    const candidateChecks=(account:FinanceLedgerAccount):Check[]=>amount&&paidAt&&postingAt?[paidAt,postingAt].flatMap(at=>[...employeeSettlementFundingChecks(ctx,account,amount.toJSON().amount,at,"view"),...employeeSettlementFundingChecks(ctx,account,amount.toJSON().amount,at,"pay")]):[];
    const eligible=(account:FinanceLedgerAccount)=>Boolean(canPay&&amount&&paidAt&&postingAt&&isExpenseFundingAccount(account)&&(input.kind==="WALLET_OFFSET"?account.teamWallet?.personId===source.retained.personId:account.teamWallet?.personId!==source.retained.personId)&&allows(candidateChecks(account)));
    if(canPay&&amount&&paidAt&&postingAt){
      if(input.kind==="WALLET_OFFSET"){
        const wallet=await readWalletLedger(tx,ctx.organizationId,source.retained.personId),funding=wallet?await finance.findLedgerAccountById(wallet.ledgerAccountId):null,balance=Money.of(wallet?.balances.find(row=>row.currency===currency.code)?.amount??"0",currency.code),available=balance.amount.gt(0)?balance:Money.zero(currency.code);
        if(funding&&wallet){const balanceChecks=employeeSettlementFundingChecks(ctx,funding,balance.amount.abs().toFixed(currency.minorUnit),now,"view");if(allows(balanceChecks)){walletAvailable=available.toJSON();disclosure.push(...balanceChecks);}if(eligible(funding)&&!amount.amount.gt(available.amount))accounts.push(funding);else{canPay=false;error="wallet_unavailable";}}
        else{canPay=false;error="wallet_unavailable";}
      }else{
        let cursor=input.fundingAfter;while(accounts.length<51){const batch=await finance.listLedgerAccounts({after:cursor,query:input.fundingQuery,take:100});if(!batch.length)break;for(const account of batch){if(eligible(account))accounts.push(account);if(accounts.length===51)break;}if(batch.length<100)break;cursor=batch.at(-1)!.id;}
        fundingNext=accounts.length>50?accounts[49].id:null;accounts.splice(50);if(input.fundingAccountId&&!accounts.some(account=>account.id===input.fundingAccountId)){const selected=await finance.findLedgerAccountById(input.fundingAccountId);if(!selected||!eligible(selected))throw new EmployeeCompensationRunAccessError();accounts.push(selected);}
      }
    }
    if(canPay){disclosure.push(...actionChecks);for(const account of accounts)disclosure.push(...candidateChecks(account));}
    const payments=source.journals.filter(journal=>!journal.reversesTransactionId&&source.receipts.has(journal.id)).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()||b.id.localeCompare(a.id)),boundary=input.before?payments.findIndex(journal=>journal.id===input.before):-1;if(input.before&&boundary<0)throw new EmployeeCompensationRunAccessError();const page=payments.slice(boundary+1,boundary+52),currentOpen=sourceVoid?await source.periods.postingOpen(now):false;
    const history=page.slice(0,50).map(journal=>{const saved=source.receipts.get(journal.id)!,funding=journal.postings.find(posting=>posting.ledgerAccountId===saved.input.fundingAccountId)?.ledgerAccount;if(!funding)throw new EmployeeCompensationRunConflictError();const reversal=journal.reversedByTransactions[0],checks=employeeSettlementVoidChecks(ctx,source,saved,journal,funding,now),canVoid=Boolean(!reversal&&currentOpen&&allows(checks));if(canVoid)disclosure.push(...checks);return{id:journal.id,kind:saved.input.kind,amount:Money.of(saved.input.amount,currency.code).toJSON(),paidAt:saved.input.paidAt,postedAt:journal.occurredAt.toISOString(),recordedAt:journal.createdAt.toISOString(),fundingName:funding.name,reference:saved.input.reference,reason:saved.input.reason,reversal:reversal?{id:reversal.id,at:reversal.occurredAt.toISOString(),reason:reversal.description}:null,canVoid};});
    const result={id:input.id,claimId:input.claimId,purpose:source.row.run.purpose,personName:metadata.labels[0]?.personName??null,earned:source.retained.amount.toJSON(),outstanding:outstanding.toJSON(),minorUnit:currency.minorUnit,timezone:calendar?.value.timezone??null,canPrepare,blocked,preview:{kind:input.kind,amount:amount?.toJSON().amount??null,paidLocal,paidAt:paidAt?.toISOString()??null,occurrence:input.occurrence,closed,canAdjust,canPay,calendarRuleId:calendar?.id??null,calendarRuleVersion:calendar?.version??null,error},accounts:accounts.map(account=>({id:account.id,name:account.name})),fundingNext,walletAvailable,payments:history,next:page.length>50?page[49].id:null};
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.settlements_viewed",resourceType:"employee_compensation_claim",resourceId:input.claimId,after:{claimId:input.claimId,paymentIds:history.map(row=>row.id)},reason:"Reviewed actual original earned liability and immutable settlement history",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    const actual=await source.recheckSettlement(await finance.clock(),disclosure),latestCalendar=await source.periods.policy(await finance.clock());if(stableJournals(actual.journals)!==stableJournals(source.journals)||latestCalendar?.id!==calendar?.id||latestCalendar?.version!==calendar?.version)throw new EmployeeCompensationRunConflictError();return employeeCompensationPaymentWorkspaceSchema.parse(result);
  },{timeout:120000});
}
