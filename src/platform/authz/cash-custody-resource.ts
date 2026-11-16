import type {Resource} from "./authorize";
export function cashCustodyDisclosureSources(organizationId:string,row:{id:string;propertyId:string;reservationId:string|null;collectorPersonId:string;collectorUserAccountId:string;transactionId:string;amount:string;recordedAt:Date;cityId:string|null;regionId:string|null}):Resource[]{
 const scope={organizationId,propertyId:row.propertyId,reservationId:row.reservationId??undefined,city:row.cityId??undefined,region:row.regionId??undefined,dataClass:"financial"as const,amount:row.amount,occurredAt:row.recordedAt,assignedPersonId:row.collectorPersonId,assignedUserAccountId:row.collectorUserAccountId};
 return[{...scope,type:"cash_collection",id:row.id,financialRecordId:row.transactionId},{...scope,type:"financial_transaction",id:row.transactionId,financialRecordId:row.transactionId},{...scope,type:"property_finance",id:row.propertyId}];
}
