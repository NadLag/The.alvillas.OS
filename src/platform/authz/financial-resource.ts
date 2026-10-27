import { authorize, type AuthContext, type Resource } from "./authorize";

/** Complete balances cannot include movements hidden by conditional grants. */
export function canViewCompleteOwnerLedger(ctx:AuthContext,resource:Resource,now:Date,action:"view"|"export"="view"):boolean{
  if(!ctx.assignments)return authorize(ctx,action,resource,now);
  const assignments=ctx.assignments.filter(assignment=>!assignment.conditions||Object.keys(assignment.conditions).length===0);
  return authorize({...ctx,assignments,permissions:new Set(assignments.flatMap(assignment=>[...assignment.permissions])),scopes:assignments.map(assignment=>assignment.scope)},action,resource,now);
}

export function ownerPayoutResource(organizationId:string,row:{id:string;ownerId:string;propertyId:string;amount:{toString():string};state:string;createdBy:string;
  reservationId?:string|null;createdAt?:Date;paidAt?:Date|null},property:{cityId:string|null;regionId:string|null}):Resource {
  return {type:"financial_transaction",organizationId,id:row.id,financialRecordId:row.id,ownerId:row.ownerId,propertyId:row.propertyId,
    reservationId:row.reservationId,amount:row.amount.toString(),status:row.state,assignedUserAccountId:row.createdBy,
    occurredAt:row.paidAt??row.createdAt,city:property.cityId,region:property.regionId,dataClass:"financial"};
}
