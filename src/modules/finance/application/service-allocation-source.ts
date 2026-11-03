import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {taskResource} from "@/platform/authz/task-resource";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {EmployeeCompensationRepository} from "../infrastructure/employee-compensation-repository";
import {ServiceAllocationSourceRepository} from "../infrastructure/service-allocation-source-repository";
import {ServiceAllocationAccessError,ServiceAllocationSourceUnavailableError,ServiceAllocationSourceChangedError} from "../domain/service-allocation";
import {validateEmployeeCompletedWorkEvidence} from "./employee-compensation-source";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

export const serviceCollectionSourceInput=z.object({collectionId:z.uuid().transform(v=>v.toLowerCase()),completionEventId:z.uuid().transform(v=>v.toLowerCase())}).strict();
/** Canonical completed-work evidence and original collected funds must both remain actual at the final write boundary. */
export async function inspectServiceAllocationCollection(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction,action:"view"|"create"="view"){
 const input=serviceCollectionSourceInput.parse(raw),repository=new ServiceAllocationSourceRepository(tx,ctx.organizationId),work=new EmployeeCompensationRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),collection=await repository.collection(input.collectionId);
 if(!collection)throw new ServiceAllocationAccessError();const task=await work.completedWork(collection.taskId);if(!task||task.organizationId!==ctx.organizationId||task.propertyId!==collection.propertyId)throw new ServiceAllocationAccessError();
 const resource={...taskResource(task),type:"cash_collection",id:collection.id,financialRecordId:collection.transactionId,reservationId:collection.reservationId,assignedUserAccountId:collection.collectorUserAccountId,assignedPersonId:collection.collectorPersonId,dataClass:"financial"as const,amount:collection.amount.toFixed(2),occurredAt:collection.recordedAt},checks=[{action:"view"as const,resource:taskResource(task)},{action:"view"as const,resource},{action:"view"as const,resource:{...resource,type:"financial_transaction",id:collection.transactionId}},...action==="create"?[{action:"create"as const,resource:{...resource,type:"financial_transaction",id:undefined,financialRecordId:undefined,occurredAt:task.completedAt}}]:[]];
 const recheckAuthority=async()=>recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new ServiceAllocationAccessError());await recheckAuthority();
 let completed:ReturnType<typeof validateEmployeeCompletedWorkEvidence>;try{completed=validateEmployeeCompletedWorkEvidence(task);}catch{throw new ServiceAllocationSourceUnavailableError();}
 const amount=Money.of(collection.amount.toFixed(2),collection.currency),journal=collection.transaction,postings=journal.postings;
 if(task.archivedAt||collection.property.archivedAt||completed.event.id!==input.completionEventId||task.completedAt!>await finance.clock()||collection.currencyRef.minorUnit>2||amount.amount.decimalPlaces()>collection.currencyRef.minorUnit||!amount.amount.gt(0)||!journal.sealed||journal.organizationId!==ctx.organizationId||journal.reversesTransactionId||journal.reversedByTransactions.length||postings.length!==2)throw new ServiceAllocationSourceUnavailableError();
 const custody=postings.find(p=>p.ledgerAccountId===collection.custodyAccountId&&p.side==="DEBIT"),unallocated=postings.find(p=>p.side==="CREDIT"&&p.ledgerAccount.code==="UNALLOCATED_COLLECTIONS");
 if(!custody||!unallocated||custody.ledgerAccount.accountType!=="ASSET_LOCATION"||custody.ledgerAccount.normalSide!=="DEBIT"||unallocated.ledgerAccount.accountType!=="CLAIM_OWNERSHIP"||unallocated.ledgerAccount.normalSide!=="CREDIT"||postings.some(p=>p.organizationId!==ctx.organizationId||p.ledgerAccount.organizationId!==ctx.organizationId||p.ledgerAccount.archivedAt||p.currency!==amount.currency||!Money.of(p.amount.toFixed(2),p.currency).equals(amount)||!z.object({cashCollectionId:z.literal(collection.id),taskId:z.literal(collection.taskId),propertyId:z.literal(collection.propertyId)}).passthrough().safeParse(p.dimensions).success))throw new ServiceAllocationSourceUnavailableError();
 const fingerprint=commandFingerprint({collection,task}),recheckSource=async()=>{await recheckAuthority();const current=await repository.collection(collection.id),currentTask=await work.completedWork(task.id);if(commandFingerprint({collection:current,task:currentTask})!==fingerprint)throw new ServiceAllocationSourceChangedError();await recheckAuthority();};
 return{collection,task,completed,amount,unallocatedAccount:unallocated.ledgerAccount,custodyAccount:custody.ledgerAccount,fingerprint,finance,recheckSource,recheckAuthority};
}
