import type { Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";

/** Approval and retained owner notices authorize the same actual source cost and allocated slice. */
export function employeeCompensationCostResource(organizationId:string,submission:{submittedBy:string;costOn:Date},cost:{id:string;propertyId:string;reservationId:string|null;timezone:string},
  slice:{ownerId:string|null;amount:{toString():string};status:string;approvalId?:string;notificationEventId?:string},property:{cityId:string|null;regionId:string|null}|null|undefined,sourceOccurredAt?:Date):Resource{
  return{type:"expense",id:cost.id,financialRecordId:cost.id,approvalId:slice.approvalId,notificationEventId:slice.notificationEventId,organizationId,propertyId:cost.propertyId,reservationId:cost.reservationId,
    ownerId:slice.ownerId,amount:slice.amount.toString(),occurredAt:sourceOccurredAt??calendarDateStart(submission.costOn.toISOString().slice(0,10),cost.timezone),assignedUserAccountId:submission.submittedBy,
    dataClass:"financial",city:property?.cityId,region:property?.regionId,status:slice.status};
}
