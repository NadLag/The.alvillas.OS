import {inspectCustodyHandoverSource} from "./custody-handover-source";
import { z } from "zod";
import { authorize,type Action,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { lockWalletHolders } from "@/platform/ledger/wallet-lock";
import { FinanceRepository,type FinanceLedgerAccount } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { financialTransferSchema,financialTransferVoidSchema,financialTransferPostings,isTransferLocation,transferKindMatches } from "../domain/financial-transfer";
import { expenseFundingWalletResource } from "../domain/expense";
import { matchesFinancialReversalAttempt } from "../domain/financial-reversal";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Check={action:Action;resource:Resource};
function custodyIdentity(postings:readonly{dimensions:unknown}[]){const ids=new Set(postings.flatMap(line=>{const value=line.dimensions;if(!value||typeof value!=="object"||Array.isArray(value))return[];const id=(value as Record<string,unknown>).custody_collection_id;return typeof id==="string"&&z.uuid().safeParse(id).success?[id]:[];}));return ids.size===1?[...ids][0]:null;}

export class FinancialTransferAccessError extends Error {}
export class FinancialTransferConflictError extends Error {}
export class FinancialTransferConfigurationError extends Error {}
function accountChecks(ctx:FinanceActorContext,accounts:FinanceLedgerAccount[],amount:string,at:Date,action:"pay"|"void"):Check[]{
  return accounts.flatMap(account=>{
    const journal:Resource={type:"financial_transaction",organizationId:ctx.organizationId,id:account.id,financialRecordId:account.id,dataClass:"financial",amount,occurredAt:at};
    const wallet=expenseFundingWalletResource(ctx.organizationId,account,amount,at);
    return [{action:"view" as const,resource:journal},{action,resource:journal},...(wallet?[{action:"view" as const,resource:wallet},{action,resource:wallet}]:[])];
  });
}
async function lockWallets(ctx:FinanceActorContext,tx:TenantTransaction,accounts:FinanceLedgerAccount[]){
  await lockWalletHolders(tx,ctx.organizationId,accounts.flatMap(account=>account.teamWallet?[account.teamWallet.personId]:[]));
}
export async function postFinancialTransfer(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=financialTransferSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const transfers=new FinancialTransferRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    await transfers.lock(input.idempotencyKey);
    const hints=await Promise.all([finance.findLedgerAccountById(input.fromAccountId),finance.findLedgerAccountById(input.toAccountId)]);
    if(hints.some(account=>!account))throw new FinancialTransferAccessError();
    await lockWallets(ctx,tx,hints as FinanceLedgerAccount[]);await transfers.lockAccounts([input.fromAccountId,input.toAccountId]);
    const [from,to]=await Promise.all([finance.findLedgerAccountById(input.fromAccountId),finance.findLedgerAccountById(input.toAccountId)]);
    if(!from||!to)throw new FinancialTransferAccessError();
    const clock=await finance.clock(),amount=Money.of(input.amount,input.currency);
    const checks:Check[]=[...accountChecks(ctx,[from,to],input.amount,clock,"pay"),{action:"create",resource:{type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial",amount:input.amount,occurredAt:clock}}];
    await recheckFinanceAuthorization(ctx,tx,clock,checks,new FinancialTransferAccessError());
    let custody:Awaited<ReturnType<typeof inspectCustodyHandoverSource>>|null=null;if(input.cashCollectionId){try{custody=await inspectCustodyHandoverSource(ctx,tx,input.cashCollectionId,clock);}catch{throw new FinancialTransferAccessError();}checks.push(...custody.sources.map(resource=>({action:"view"as const,resource})));}
    const existing=(await finance.findTransactionsByIdempotencyKeys([`transfer:${input.idempotencyKey}`]))[0];
    if(existing){
      const audit=await transfers.postedAudit(existing.id),saved=financialTransferSchema.safeParse(audit?.after);
      if(!audit||audit.actorId!==ctx.actorId||audit.reason!==input.reason||!saved.success||JSON.stringify(saved.data)!==JSON.stringify(input)||existing.createdBy!==ctx.actorId||existing.description!==input.purpose)throw new FinancialTransferConflictError();
      return{id:existing.id,idempotent:true};
    }
    const currency=await transfers.currency(input.currency);
    if(!currency||currency.minorUnit>2||amount.amount.decimalPlaces()>currency.minorUnit||!(custody?custody.sealed&&!custody.reversed&&from.id===custody.custodyAccountId&&from.code==="CASH_CUSTODY_"+custody.collectorPersonId.replaceAll("-","").toUpperCase()&&!from.archivedAt&&from.accountType==="ASSET_LOCATION"&&from.normalSide==="DEBIT"&&isTransferLocation(to)&&["ASSET","ASSET_LOCATION"].includes(to.accountType)&&input.currency===custody.currency&&custody.available.amount.gte(amount.amount):isTransferLocation(from)&&isTransferLocation(to)&&transferKindMatches(input.kind,from,to)))throw new FinancialTransferConfigurationError();
    const row=await finance.createFinancialTransaction({reference:`TRANSFER:${input.idempotencyKey}`,description:input.purpose,occurredAt:clock,
      idempotencyKey:`transfer:${input.idempotencyKey}`,createdBy:ctx.actorId,postings:financialTransferPostings(input),
      recheckAuthorization:at=>recheckFinanceAuthorization(ctx,tx,at,checks,new FinancialTransferAccessError())});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.transfer.posted",resourceType:"financial_transaction",resourceId:row.id,
      after:input,reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock});
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new FinancialTransferAccessError());if(custody)await custody.recheck();
    return{id:row.id,idempotent:false};
  });
}
export async function voidFinancialTransfer(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=financialTransferVoidSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const transfers=new FinancialTransferRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    const hint=await transfers.journal(input.id),source=hint&&financialTransferSchema.safeParse((await transfers.postedAudit(input.id))?.after);
    if(!hint||!source?.success)throw new FinancialTransferAccessError();
    await transfers.lock(source.data.idempotencyKey);
    const accounts=await Promise.all([finance.findLedgerAccountById(source.data.fromAccountId),finance.findLedgerAccountById(source.data.toAccountId)]);
    if(accounts.some(account=>!account))throw new FinancialTransferAccessError();
    await lockWallets(ctx,tx,accounts as FinanceLedgerAccount[]);await transfers.lockAccounts(accounts.map(account=>account!.id));
    const row=await transfers.journal(input.id);if(!row||row.reference!==`TRANSFER:${source.data.idempotencyKey}`||row.reversesTransactionId)throw new FinancialTransferConflictError();
    const clock=await finance.clock(),target:Resource={type:"financial_transaction",organizationId:ctx.organizationId,id:row.id,financialRecordId:row.id,dataClass:"financial",amount:source.data.amount,occurredAt:row.occurredAt};
    const checks:Check[]=[{action:"view",resource:target},{action:"void",resource:target},...accountChecks(ctx,accounts as FinanceLedgerAccount[],source.data.amount,row.occurredAt,"void")];if(source.data.cashCollectionId){try{const custody=await inspectCustodyHandoverSource(ctx,tx,source.data.cashCollectionId,clock);checks.push(...custody.sources.map(resource=>({action:"view"as const,resource})));}catch{throw new FinancialTransferAccessError();}}
    await recheckFinanceAuthorization(ctx,tx,clock,checks,new FinancialTransferAccessError());
    if(row.reversedByTransactions.length){
      const audit=await finance.financialReversalAudit("finance.transfer.reversed","financial_transaction",[row.id]);
      if(!matchesFinancialReversalAttempt({actorId:ctx.actorId,reason:input.reason,originalIds:[row.id],reversals:row.reversedByTransactions,audit}))throw new FinancialTransferConflictError();
      return{id:row.id,reversalTransactionId:row.reversedByTransactions[0].id,idempotent:true};
    }
    const reverse=await finance.createFinancialTransaction({reference:`TRANSFER:${source.data.idempotencyKey}:VOID`,description:input.reason,occurredAt:clock,
      idempotencyKey:`transfer:${source.data.idempotencyKey}:void`,reversesTransactionId:row.id,createdBy:ctx.actorId,postings:row.postings.map(posting=>({ledgerAccountId:posting.ledgerAccountId,
        side:posting.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,amount:Money.of(posting.amount.toString(),posting.currency),bucket:z.string().parse(posting.bucket),dimensions:z.record(z.string(),z.unknown()).parse(posting.dimensions)})),
      recheckAuthorization:at=>recheckFinanceAuthorization(ctx,tx,at,checks,new FinancialTransferAccessError())});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.transfer.reversed",resourceType:"financial_transaction",resourceId:row.id,
      after:{originalTransactionIds:[row.id],reversalTransactionIds:[reverse.id]},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock});
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new FinancialTransferAccessError());
    return{id:row.id,reversalTransactionId:reverse.id,idempotent:false};
  });
}
export async function listFinancialTransfers(ctx:FinanceActorContext,raw:unknown={},deps:Deps={}){
  const input=z.object({after:z.uuid().optional()}).strict().parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const finance=new FinanceRepository(tx,ctx.organizationId),clock=await finance.clock();
    const chart:Resource={type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial"};
    await recheckFinanceAuthorization(ctx,tx,clock,[{action:"view",resource:chart}],new FinancialTransferAccessError());
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    const repository=new FinancialTransferRepository(tx,ctx.organizationId);
    const rows:Awaited<ReturnType<typeof repository.list>>=[],custodyChecks:Check[]=[];let cursor=input.after;
    while(rows.length<51){
      const batch=await repository.list(cursor);if(!batch.length)break;
      for(const row of batch){
        const amount=row.postings[0]?.amount.toString()??"0",resource={...chart,id:row.id,financialRecordId:row.id,amount,occurredAt:row.occurredAt};
        const checks:Check[]=[{action:"view",resource},...accountChecks(ctx,row.postings.map(posting=>posting.ledgerAccount),amount,row.occurredAt,"void").filter(check=>check.action==="view")];
        const custodyId=custodyIdentity(row.postings);if(custodyId){try{const source=await inspectCustodyHandoverSource(ctx,tx,custodyId,clock);checks.push(...source.sources.map(resource=>({action:"view"as const,resource})));}catch{continue;}}
        if(checks.every(check=>[ctx.authContext,current].every(authority=>authorize(authority,check.action,check.resource,clock)))){rows.push(row);if(custodyId)custodyChecks.push(...checks);}
        if(rows.length===51)break;
      }
      if(batch.length<51)break;cursor=batch.at(-1)!.id;
    }
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),custodyChecks,new FinancialTransferAccessError());
    return{rows:rows.slice(0,50).map(row=>{
      const amount=row.postings[0]?.amount.toString()??"0",resource={...chart,id:row.id,financialRecordId:row.id,amount,occurredAt:row.occurredAt};
      const checks:Check[]=[{action:"view",resource},{action:"void",resource},...accountChecks(ctx,row.postings.map(posting=>posting.ledgerAccount),amount,row.occurredAt,"void")];
      return{...row,canVoid:!row.reversedByTransactions.length&&checks.every(check=>[ctx.authContext,current].every(authority=>authorize(authority,check.action,check.resource,clock)))};
    }),next:rows.length>50?rows[49].id:undefined,canCreate:[ctx.authContext,current].every(authority=>authorize(authority,"create",{...chart,amount:"0",occurredAt:clock},clock))};
  });
}
export async function assertFinancialTransferViewer(ctx:FinanceActorContext,deps:Deps={}){
  await withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const clock=await new FinanceRepository(tx,ctx.organizationId).clock();
    await recheckFinanceAuthorization(ctx,tx,clock,[{action:"view",resource:{type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial"}}],new FinancialTransferAccessError());
  });
}
/** Nonce-only recovery waits behind the original native command lock. No
 * editable source body or financial details are stored in the browser. */
export async function recoverCustodyHandover(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=z.object({cashCollectionId:z.uuid(),idempotencyKey:z.uuid()}).strict().parse(raw);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const transfers=new FinancialTransferRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await transfers.lock(input.idempotencyKey);
  let source:Awaited<ReturnType<typeof inspectCustodyHandoverSource>>;try{source=await inspectCustodyHandoverSource(ctx,tx,input.cashCollectionId,await finance.clock());}catch{throw new FinancialTransferAccessError();}
  const journal=(await finance.findTransactionsByIdempotencyKeys(["transfer:"+input.idempotencyKey]))[0];if(!journal)return{recorded:false,id:null};
  const proof=await transfers.postedAudit(journal.id),saved=financialTransferSchema.safeParse(proof?.after);
  if(!proof||proof.actorId!==ctx.actorId||journal.createdBy!==ctx.actorId||!saved.success||saved.data.kind!=="CUSTODY_HANDOVER"||saved.data.cashCollectionId!==input.cashCollectionId||saved.data.idempotencyKey!==input.idempotencyKey)throw new FinancialTransferConflictError();
  const accounts=await Promise.all([finance.findLedgerAccountById(saved.data.fromAccountId),finance.findLedgerAccountById(saved.data.toAccountId)]);if(accounts.some(account=>!account))throw new FinancialTransferAccessError();
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),[{action:"view",resource:{type:"financial_transaction",organizationId:ctx.organizationId,id:journal.id,financialRecordId:journal.id,dataClass:"financial",amount:saved.data.amount,occurredAt:journal.occurredAt}},...accountChecks(ctx,accounts as FinanceLedgerAccount[],saved.data.amount,journal.occurredAt,"void").filter(check=>check.action==="view")],new FinancialTransferAccessError());await source.recheck();return{recorded:true,id:journal.id};
 });
}
export async function getFinancialTransferEditor(ctx:FinanceActorContext,raw:unknown={},deps:Deps={}){
  const input=z.object({query:z.string().trim().max(120).optional(),after:z.uuid().optional(),from:z.uuid().optional(),to:z.uuid().optional(),cashCollectionId:z.uuid().optional()}).strict().parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const finance=new FinanceRepository(tx,ctx.organizationId),clock=await finance.clock(),chart:Resource={type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial"};
    await recheckFinanceAuthorization(ctx,tx,clock,[{action:"view",resource:chart}],new FinancialTransferAccessError());
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    let custody:Awaited<ReturnType<typeof inspectCustodyHandoverSource>>|null=null;if(input.cashCollectionId){try{custody=await inspectCustodyHandoverSource(ctx,tx,input.cashCollectionId,clock);}catch{throw new FinancialTransferAccessError();}if(!custody.sealed||custody.reversed||input.from&&input.from!==custody.custodyAccountId)throw new FinancialTransferAccessError();}
    const visible=(account:FinanceLedgerAccount)=>{
      const wallet=expenseFundingWalletResource(ctx.organizationId,account,"0");
      return (isTransferLocation(account)&&(!custody||["ASSET","ASSET_LOCATION"].includes(account.accountType))||Boolean(custody&&account.id===custody.custodyAccountId&&!account.archivedAt))&&[ctx.authContext,current].every(authority=>authorize(authority,"view",{...chart,id:account.id,financialRecordId:account.id,amount:"0",occurredAt:clock},clock)&&(!wallet||authorize(authority,"view",wallet,clock)));
    };
    const available:FinanceLedgerAccount[]=[];let cursor=input.after;
    while(available.length<51){
      const batch=await finance.listLedgerAccounts({after:cursor,query:input.query,take:100});
      if(!batch.length)break;
      for(const account of batch){if(visible(account))available.push(account);if(available.length===51)break}
      if(batch.length<100)break;cursor=batch.at(-1)!.id;
    }
    const next=available.length>50?available[49].id:undefined,accounts=available.slice(0,50);
    for(const id of [...new Set([custody?.custodyAccountId??input.from,input.to].filter((id):id is string=>Boolean(id)))]){
      if(accounts.some(account=>account.id===id))continue;
      const account=await finance.findLedgerAccountById(id);if(!account||!visible(account))throw new FinancialTransferAccessError();accounts.push(account);
    }
    const choices=await new FinancialTransferRepository(tx,ctx.organizationId).currencyChoices();
    if(custody)await custody.recheck();
    return{accounts:accounts.map(account=>({id:account.id,name:account.name})),next,...choices,custody:custody?{collectionId:custody.id,fromAccountId:custody.custodyAccountId,available:custody.available.toJSON()}:null};
  });
}
