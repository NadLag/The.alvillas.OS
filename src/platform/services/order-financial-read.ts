import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {Money} from "@/platform/money/money";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {ServiceAllocationPostingRepository} from "@/modules/finance/infrastructure/service-allocation-posting-repository";
import {recheckServiceAllocationRead} from "@/modules/finance/application/service-allocation-command-service";
import {inspectServiceAllocationCollection} from "@/modules/finance/application/service-allocation-source";
import {readServiceAllocationSnapshot} from "@/modules/finance/domain/service-allocation-snapshot";
import {ServiceOrderAccessError,ServiceOrderConflictError} from "@/modules/services/domain/service-order";
import {serviceOrderFinancialPageTotals,type RecognizedServiceOrderAmounts} from "@/modules/services/domain/service-order-financial";

type Order={id:string;taskId:string|null;propertyId:string;reservationId:string;serviceKey:string;currency:string};
/** Reuse the native actual-work, collection, source, cost and journal chains;
 * this projection creates neither another financial source nor a balance. */
export async function nativeServiceOrderFinancialPage(actor:AccountActorContext,tx:TenantTransaction,order:Order,after?:string){
 const heads=order.taskId?await new FinanceRepository(tx,actor.organizationId).serviceOrderFinancialSourceHeads(order.taskId,after):[],selected=heads.slice(0,20),postings=new ServiceAllocationPostingRepository(tx,actor.organizationId),recognized:RecognizedServiceOrderAmounts[]=[],items=[];
 for(const head of selected){
  const root=await recheckServiceAllocationRead(actor,tx,head.id);if(root.collection.taskId!==order.taskId||root.collection.propertyId!==order.propertyId||root.collection.reservationId!==order.reservationId)throw new ServiceOrderAccessError();
  const active=await postings.activeRecognition(root.id);if(!active){items.push({sourceId:root.id,collectionId:root.cashCollectionId,postingId:null,amounts:null});continue;}
  const source=await inspectServiceAllocationCollection(actor,{collectionId:root.cashCollectionId,completionEventId:root.completionEventId},tx),original=readServiceAllocationSnapshot(active.admission.snapshot);
  if(!active.transaction.sealed||active.transaction.reversedByTransactions.length||original.snapshot.recipe.service_key!==order.serviceKey||original.snapshot.source.taskId!==order.taskId||original.snapshot.source.collectionId!==root.cashCollectionId||original.gross.currency!==order.currency)throw new ServiceOrderConflictError();
  const sum=(beneficiaries:readonly string[])=>original.parts.filter(part=>beneficiaries.includes(part.beneficiary)).reduce((total,part)=>total.add(part.amount),Money.zero(order.currency)),amounts:RecognizedServiceOrderAmounts={sourceId:root.id,collectionId:root.cashCollectionId,postingId:active.id,transactionId:active.transactionId,costIds:original.providerCosts.map(cost=>cost.sourceKind+":"+cost.costId),gross:original.gross,companyRevenue:sum(["COMPANY","SUPPLIER","PERSON"]),providerCost:original.providerCosts.reduce((total,cost)=>total.add(cost.amount),Money.zero(order.currency)),ownerAmount:sum(["OWNER"]),taxAmount:sum(["TAX"])};
  recognized.push(amounts);items.push({sourceId:root.id,collectionId:root.cashCollectionId,postingId:active.id,amounts:serviceOrderFinancialPageTotals(order.currency,[amounts])});await source.recheckSource();await recheckServiceAllocationRead(actor,tx,root.id);const current=await postings.activeRecognition(root.id);if(current?.id!==active.id||!current.transaction.sealed||current.transaction.reversedByTransactions.length)throw new ServiceOrderConflictError();
 }
 for(const head of selected)await recheckServiceAllocationRead(actor,tx,head.id);
 return{items,next:heads.length>20?selected.at(-1)!.id:null,currency:order.currency,pageTotals:serviceOrderFinancialPageTotals(order.currency,recognized)};
}
