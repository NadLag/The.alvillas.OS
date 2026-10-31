import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { lockWalletHolders,readWalletLedger } from "@/platform/ledger/wallet-lock";
import { Money } from "@/platform/money/money";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import type { FinanceLedgerAccount } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { EmployeePayableRepository } from "../infrastructure/employee-payable-repository";
import { expenseFundingWalletResource,isExpenseFundingAccount } from "../domain/expense";
import { employeePaymentPostings,employeeWalletOffsetPostings } from "../domain/employee-payable";
import { employeeCompensationSettlementInput,employeeCompensationSettlementVoidInput,employeeCompensationSettlementAuditSchema,employeeCompensationSettlementRecoveryInput } from "../domain/employee-compensation-settlement";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { matchesFinancialReversalAttempt } from "../domain/financial-reversal";
import { inspectEmployeeCompensationRecognition } from "./employee-compensation-recognition";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import type { recheckFinanceAuthorization,FinanceActorContext } from "./finance-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Source=Awaited<ReturnType<typeof inspectEmployeeCompensationRecognition>>;
type Check=Parameters<typeof recheckFinanceAuthorization>[3][number];
type Receipt=z.infer<typeof employeeCompensationSettlementAuditSchema>;
function paymentResource(ctx:FinanceActorContext,source:Source,amount:string,at:Date,id?:string,createdBy?:string){
  const properties=new Set(source.retained.costs.map(cost=>cost.propertyId)),first=source.retained.costs[0],actual=source.row.costs.find(cost=>cost.id===first.id)!;
  const{financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,createdBy??ctx.actorId,{...actual,taskId:actual.runLine.taskId},at);
  return{type:"financial_transaction" as const,organizationId:ctx.organizationId,dataClass:"financial" as const,id,financialRecordId:id,assignedUserAccountId:createdBy??ctx.actorId,occurredAt:at,amount,
    ...(properties.size===1?{propertyId:financial.propertyId,city:financial.city,region:financial.region}: {})};
}
function fundingChecks(ctx:FinanceActorContext,account:FinanceLedgerAccount,amount:string,at:Date,action:"view"|"pay"|"void"):Check[]{
  const target={type:"financial_transaction" as const,organizationId:ctx.organizationId,id:account.id,financialRecordId:account.id,dataClass:"financial" as const,amount,occurredAt:at},wallet=expenseFundingWalletResource(ctx.organizationId,account,amount,at);
  return[{action:"view",resource:target},{action,resource:target},...(wallet?[{action:"view" as const,resource:wallet},{action,resource:wallet}]:[])];
}
async function prepareSettlement(ctx:FinanceActorContext,id:string,claimId:string,tx:TenantTransaction,action:"view"|"pay"|"void"){
  const source=await inspectEmployeeCompensationRecognition(ctx,id,claimId,tx),payables=new EmployeePayableRepository(tx,ctx.organizationId);if(!source.existing)throw new EmployeeCompensationRunConflictError();
  const facts=employeeCompensationRunFacts(ctx.organizationId,source.row.run);
  const recheck=async(at:Date,extra:Check[]=[])=>{
    await source.recheck();const checks:Check[]=[...extra];
    if(action!=="view")for(const cost of source.retained.costs){const actual=source.row.costs.find(line=>line.id===cost.id)!,link=source.existing!.lines.find(line=>line.costId===cost.id)!;
      const{financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,source.row.run.createdBy,{...actual,taskId:actual.runLine.taskId},cost.sourceOccurredAt);
      checks.push({action,resource:financial},{action,resource:{...financial,id:link.transactionId,financialRecordId:link.transactionId,occurredAt:link.transaction.occurredAt}});}
    const journals=await payables.journals(claimId),paymentIds=journals.filter(journal=>!journal.reversesTransactionId&&journal.postings.some(posting=>["EMPLOYEE_PAYMENT","COMPENSATION_OFFSET"].includes(posting.bucket??""))).map(journal=>journal.id),audits=await payables.audits(paymentIds),receipts=new Map<string,Receipt>();
    for(const audit of audits){if(!audit.resourceId||receipts.has(audit.resourceId))throw new EmployeeCompensationRunConflictError();receipts.set(audit.resourceId,employeeCompensationSettlementAuditSchema.parse(audit.after));}
    for(const journal of journals){const saved=receipts.get(journal.reversesTransactionId??journal.id);if(!saved){if(journal.postings.some(posting=>["EMPLOYEE_PAYMENT","COMPENSATION_OFFSET"].includes(posting.bucket??"")))throw new EmployeeCompensationRunConflictError();continue;}
      if(saved.input.id!==id||saved.input.claimId!==claimId||saved.recognitionId!==source.existing!.id)throw new EmployeeCompensationRunConflictError();
      const funding=journal.postings.find(posting=>posting.ledgerAccountId===saved.input.fundingAccountId)?.ledgerAccount;if(!funding)throw new EmployeeCompensationRunConflictError();
      for(const instant of[new Date(saved.input.paidAt),journal.occurredAt]){const resource=paymentResource(ctx,source,saved.input.amount,instant,journal.id,journal.createdBy??undefined);checks.push({action:"view",resource,organizationOnly:!resource.propertyId},...fundingChecks(ctx,funding,saved.input.amount,instant,"view"));}
    }
    await recheckEmployeeCompensationRun(ctx,tx,at,facts,action,checks);return{journals,receipts};
  };
  const observed=await recheck(await source.finance.clock());return{...source,payables,...observed,recheckSettlement:recheck};
}

/** Record an actual payment or explicit wallet offset against an existing earned liability. */
export async function postEmployeeCompensationSettlement(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSettlementInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const payables=new EmployeePayableRepository(tx,ctx.organizationId);await payables.lockKey(input.idempotencyKey);const source=await prepareSettlement(ctx,input.id,input.claimId,tx,"pay"),finance=source.finance,hint=await finance.findLedgerAccountById(input.fundingAccountId);if(!hint)throw new EmployeeCompensationRunAccessError();
    await lockWalletHolders(tx,ctx.organizationId,hint.teamWallet?[hint.teamWallet.personId]:[]);await new FinancialTransferRepository(tx,ctx.organizationId).lockAccounts([hint.id]);const funding=await finance.findLedgerAccountById(hint.id);if(!funding)throw new EmployeeCompensationRunAccessError();
    const existing=(await finance.findTransactionsByIdempotencyKeys([`employee-settlement:${input.idempotencyKey}`]))[0],saved=existing?source.receipts.get(existing.id):null,paidAt=new Date(input.paidAt),now=await finance.clock(),postedAt=existing?.occurredAt??(input.currentPeriod?now:paidAt),target=paymentResource(ctx,source,input.amount,paidAt,existing?.id,existing?.createdBy??undefined);
    const checks:Check[]=[{action:"view",resource:target,organizationOnly:!target.propertyId},{action:"pay",resource:target,organizationOnly:!target.propertyId},{action:"create",resource:{...target,id:undefined,financialRecordId:undefined,occurredAt:postedAt},organizationOnly:!target.propertyId},...fundingChecks(ctx,funding,input.amount,paidAt,"pay"),...fundingChecks(ctx,funding,input.amount,postedAt,"pay")];
    if(input.currentPeriod)checks.push({action:"override",resource:target,organizationOnly:!target.propertyId});await source.recheckSettlement(now,checks);
    if(existing){const audit=(await payables.audits([existing.id]))[0];if(!saved||existing.createdBy!==ctx.actorId||audit?.actorId!==ctx.actorId||audit.reason!==input.reason||JSON.stringify(saved.input)!==JSON.stringify(input)||saved.transactionId!==existing.id)throw new EmployeeCompensationRunConflictError();await source.recheckSettlement(await finance.clock(),checks);return{id:input.id,claimId:input.claimId,paymentId:existing.id,kind:input.kind,idempotent:true};}
    if(source.journals.some(journal=>source.existing!.lines.some(line=>line.transactionId===journal.id)&&journal.reversedByTransactions.length))throw new EmployeeCompensationRunConflictError();
    const currency=await source.claims.currency(input.currency),amount=Money.of(input.amount,input.currency),outstanding=await payables.outstanding({claimId:input.claimId,personId:source.retained.personId,currency:input.currency});
    if(input.currency!==source.retained.amount.currency||!currency||amount.amount.decimalPlaces()>currency.minorUnit||!isExpenseFundingAccount(funding))throw new ExpensePolicyUnavailableError();if(paidAt>now||amount.amount.gt(outstanding.amount)||!outstanding.amount.gt(0))throw new EmployeeCompensationRunConflictError();
    const closed=input.currentPeriod?await source.periods.postingPeriod(paidAt):null;if(input.currentPeriod&&(await source.periods.postingOpen(paidAt)||!closed?.events[0]))throw new EmployeeCompensationRunConflictError();
    const liability=source.journals.flatMap(journal=>journal.postings).find(posting=>posting.ledgerAccount.code==="EMPLOYEE_PAYABLE")?.ledgerAccount;if(!liability||liability.archivedAt||liability.accountType!=="CLAIM_OWNERSHIP"||liability.normalSide!=="CREDIT")throw new ExpensePolicyUnavailableError();
    const base={claimId:input.claimId,personId:source.retained.personId,settlementId:input.idempotencyKey,liabilityAccountId:liability.id,amount,outstanding};let postings;
    if(input.kind==="WALLET_OFFSET"){const wallet=await readWalletLedger(tx,ctx.organizationId,source.retained.personId),available=wallet?.balances.find(balance=>balance.currency===input.currency);if(!wallet||wallet.ledgerAccountId!==funding.id||!available||amount.amount.gt(Money.of(available.amount,input.currency).amount))throw new EmployeeCompensationRunConflictError();postings=employeeWalletOffsetPostings({...base,wallet:funding,available:Money.of(available.amount,input.currency)});}
    else postings=employeePaymentPostings({...base,funding});
    const journal=await finance.createFinancialTransaction({reference:`EMPLOYEE-SETTLEMENT:${input.idempotencyKey}`,description:input.reason,occurredAt:postedAt,idempotencyKey:`employee-settlement:${input.idempotencyKey}`,createdBy:ctx.actorId,postings,recheckAuthorization:at=>source.recheckSettlement(at,checks).then(()=>undefined)});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_settlement.posted",resourceType:"financial_transaction",resourceId:journal.id,after:{input,recognitionId:source.existing!.id,transactionId:journal.id,sourcePeriodId:closed?.id??null,sourcePeriodEventId:closed?.events[0].id??null,postedAt:postedAt.toISOString()},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
    await source.recognitions.flushGuards();await source.recheckSettlement(await finance.clock(),checks);return{id:input.id,claimId:input.claimId,paymentId:journal.id,kind:input.kind,idempotent:false};
  },{timeout:120000});
}

/** Exact opposite journals restore the derived earned liability without rewriting a payment. */
export async function voidEmployeeCompensationSettlement(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSettlementVoidInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const source=await prepareSettlement(ctx,input.id,input.claimId,tx,"void"),original=source.journals.find(journal=>journal.id===input.paymentId),saved=source.receipts.get(input.paymentId);if(!original||!saved||original.reversesTransactionId||saved.transactionId!==original.id)throw new EmployeeCompensationRunAccessError();
    const hint=await source.finance.findLedgerAccountById(saved.input.fundingAccountId);if(!hint)throw new EmployeeCompensationRunAccessError();await lockWalletHolders(tx,ctx.organizationId,hint.teamWallet?[hint.teamWallet.personId]:[]);await new FinancialTransferRepository(tx,ctx.organizationId).lockAccounts([hint.id]);const funding=await source.finance.findLedgerAccountById(hint.id);if(!funding)throw new EmployeeCompensationRunAccessError();
    const now=await source.finance.clock(),postedAt=original.reversedByTransactions[0]?.occurredAt??now,checks:Check[]=[];for(const at of[new Date(saved.input.paidAt),original.occurredAt,postedAt]){const target=paymentResource(ctx,source,saved.input.amount,at,original.id,original.createdBy??undefined);checks.push({action:"void",resource:target,organizationOnly:!target.propertyId},...fundingChecks(ctx,funding,saved.input.amount,at,"void"));}
    const target=paymentResource(ctx,source,saved.input.amount,postedAt);checks.push({action:"create",resource:target,organizationOnly:!target.propertyId});await source.recheckSettlement(now,checks);
    if(original.reversedByTransactions.length){const audit=await source.payables.reversalAudit(original.id);if(!matchesFinancialReversalAttempt({actorId:ctx.actorId,reason:input.reason,originalIds:[original.id],reversals:original.reversedByTransactions,audit}))throw new EmployeeCompensationRunConflictError();return{id:input.id,claimId:input.claimId,paymentId:original.id,reversalTransactionId:original.reversedByTransactions[0].id,idempotent:true};}
    const reversed=await source.finance.createFinancialTransaction({reference:original.reference+":VOID",description:input.reason,occurredAt:postedAt,idempotencyKey:original.idempotencyKey+":void",reversesTransactionId:original.id,createdBy:ctx.actorId,
      postings:original.postings.map(posting=>({ledgerAccountId:posting.ledgerAccountId,side:posting.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,amount:Money.of(posting.amount.toString(),posting.currency),bucket:z.string().parse(posting.bucket),dimensions:z.record(z.string(),z.unknown()).parse(posting.dimensions)})),recheckAuthorization:at=>source.recheckSettlement(at,checks).then(()=>undefined)});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_settlement.reversed",resourceType:"financial_transaction",resourceId:original.id,after:{submissionId:input.id,claimId:input.claimId,originalTransactionIds:[original.id],reversalTransactionIds:[reversed.id]},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});await source.recognitions.flushGuards();await source.recheckSettlement(await source.finance.clock(),checks);return{id:input.id,claimId:input.claimId,paymentId:original.id,reversalTransactionId:reversed.id,idempotent:false};
  },{timeout:120000});
}

export async function recoverEmployeeCompensationSettlement(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSettlementRecoveryInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const source=await prepareSettlement(ctx,input.id,input.claimId,tx,"view"),journal=(await source.finance.findTransactionsByIdempotencyKeys([`employee-settlement:${input.key}`]))[0];if(!journal)return{payment:null};
    const saved=source.receipts.get(journal.id),audit=(await source.payables.audits([journal.id]))[0];if(!saved||saved.input.id!==input.id||saved.input.claimId!==input.claimId||journal.createdBy!==ctx.actorId||audit?.actorId!==ctx.actorId)throw new EmployeeCompensationRunAccessError();await source.recheckSettlement(await source.finance.clock());return{payment:{id:input.id,claimId:input.claimId,paymentId:journal.id,kind:saved.input.kind,idempotent:true}};
  },{timeout:120000});
}
