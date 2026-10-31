import type {Resource} from "./authorize";
import {Money} from "@/platform/money/money";
import {financialJournalExposure} from "@/platform/ledger/journal-exposure";

export const employeePercentageAuthorityWitnessFields={position:true,isEarningBase:true,journalAmount:true,propertyId:true,sourceCityId:true,sourceRegionId:true,reservationId:true,taskId:true,ownerId:true,
 posting:{select:{id:true,amount:true,currency:true,bucket:true,side:true,transaction:{select:{id:true,reference:true,occurredAt:true,createdBy:true}}}},
 compensation:{select:{id:true,version:true,amount:true,currency:true,assignment:{select:{personId:true,scopeType:true,scopeId:true}}}},configRule:{select:{id:true,version:true}},policyRule:{select:{id:true,version:true}}} as const;
type Amount={toString():string};
export type EmployeePercentageAuthorityWitness={isEarningBase:boolean;journalAmount:Amount;propertyId:string|null;sourceCityId:string|null;sourceRegionId:string|null;reservationId:string|null;taskId:string|null;ownerId:string|null;
 posting:{currency:string;transaction:{id:string;occurredAt:Date;createdBy:string|null}};compensation:{amount:Amount;currency:string;assignment:{personId:string;scopeType:string;scopeId:string|null}}};

/** All scope and amount inputs are immutable typed source rows, never caller snapshots. */
export function employeePercentageAuthorityFacts(organizationId:string,personId:string,currency:string,beneficiaryTotal:Money,contract:Resource,witnesses:readonly EmployeePercentageAuthorityWitness[],exposure=financialJournalExposure(witnesses.map(row=>({transactionId:row.posting.transaction.id,currency:row.posting.currency,amount:row.journalAmount.toString()})))){
 const salarySources:Resource[]=[],financialSources:Resource[]=[];
 for(const witness of witnesses){
  const{posting,compensation}=witness,transaction=posting.transaction;
  if(compensation.assignment.personId!==personId||compensation.currency!==currency||beneficiaryTotal.currency!==currency)throw Error("Percentage authority differs from its actual original contract");
  const scope={organizationId,propertyId:witness.propertyId,city:witness.sourceCityId,region:witness.sourceRegionId,reservationId:witness.reservationId,taskId:witness.taskId,jobId:witness.taskId,ownerId:witness.ownerId,dataClass:"financial" as const,occurredAt:transaction.occurredAt};
  const original=Money.of(witness.journalAmount.toString(),posting.currency),whole=exposure.get(posting.currency)!;
  const financial:Resource={...scope,type:"financial_transaction",id:transaction.id,financialRecordId:transaction.id,assignedUserAccountId:transaction.createdBy,amount:original.toJSON().amount};financialSources.push(financial);if(!whole.equals(original))financialSources.push({...financial,amount:whole.toJSON().amount});
  if(witness.isEarningBase)for(const source of [contract,{...scope,type:"staff_compensation",id:personId,assignedPersonId:personId}]){
   for(const amount of [Money.of(compensation.amount.toString(),currency).toJSON().amount,beneficiaryTotal.toJSON().amount])salarySources.push({...source,occurredAt:transaction.occurredAt,amount});
  }
 }
 return{salarySources,financialSources};
}
