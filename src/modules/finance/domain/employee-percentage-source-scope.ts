import {z} from "zod";
import {EmployeeCompensationSourceUnavailableError} from "./employee-compensation";

const references=z.object({property_id:z.uuid().optional(),owner_id:z.uuid().optional(),reservation_id:z.uuid().optional(),task_id:z.uuid().optional(),job_id:z.uuid().optional()});
export type EmployeePercentageScopeReferences=z.infer<typeof references>;

/** References come from the retained journal; callers cannot supply replacement scope labels. */
export function employeePercentageScopeReferences(dimensions:unknown):EmployeePercentageScopeReferences{
 const parsed=references.safeParse(dimensions??{});
 if(!parsed.success||parsed.data.task_id&&parsed.data.job_id&&parsed.data.task_id!==parsed.data.job_id)throw new EmployeeCompensationSourceUnavailableError();
 return parsed.data;
}

/** Every retained reference must resolve to its actual tenant row and agree with linked sources. */
export function employeePercentageSourceScope(refs:EmployeePercentageScopeReferences,facts:{
 properties:ReadonlyMap<string,{id:string;cityId:string|null;regionId:string|null}>;
 reservations:ReadonlyMap<string,{id:string;propertyId:string}>;
 tasks:ReadonlyMap<string,{id:string;propertyId:string;reservationId:string|null}>;
 owners:ReadonlyMap<string,{id:string}>;
}){
 const taskId=refs.task_id??refs.job_id,task=taskId?facts.tasks.get(taskId):undefined;
 if(taskId&&!task||refs.reservation_id&&!facts.reservations.has(refs.reservation_id)||refs.owner_id&&!facts.owners.has(refs.owner_id))throw new EmployeeCompensationSourceUnavailableError();
 if(task&&refs.reservation_id&&task.reservationId!==refs.reservation_id)throw new EmployeeCompensationSourceUnavailableError();
 const reservationId=refs.reservation_id??task?.reservationId??undefined,reservation=reservationId?facts.reservations.get(reservationId):undefined;
 if(reservationId&&!reservation)throw new EmployeeCompensationSourceUnavailableError();
 const propertyId=refs.property_id??reservation?.propertyId??task?.propertyId,property=propertyId?facts.properties.get(propertyId):undefined;
 if(propertyId&&!property||propertyId&&reservation&&reservation.propertyId!==propertyId||propertyId&&task&&task.propertyId!==propertyId)throw new EmployeeCompensationSourceUnavailableError();
 return{propertyId,city:property?.cityId,region:property?.regionId,reservationId,taskId,jobId:taskId,ownerId:refs.owner_id};
}
