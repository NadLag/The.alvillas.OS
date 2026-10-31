import type { Resource } from "./authorize";

type TaskSource={id:string;organizationId:string;propertyId:string;state:string;assignedToUserAccountId:string|null;assignedToPersonId:string|null;property:{cityId:string|null;city:string;regionId:string|null;region:string|null}};
/** Operational and financial-source readers authorize the same actual task facts. */
export function taskResource(task:TaskSource):Resource{return{type:"task",organizationId:task.organizationId,id:task.id,taskId:task.id,jobId:task.id,propertyId:task.propertyId,status:task.state,assignedUserAccountId:task.assignedToUserAccountId,assignedPersonId:task.assignedToPersonId,city:task.property.cityId??task.property.city,region:task.property.regionId??task.property.region};}
