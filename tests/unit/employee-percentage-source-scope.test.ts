import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {EmployeeCompensationSourceUnavailableError} from "@/modules/finance/domain/employee-compensation";
import {employeePercentageScopeReferences,employeePercentageSourceScope} from "@/modules/finance/domain/employee-percentage-source-scope";

function fixture(){
 const propertyId=randomUUID(),cityId=randomUUID(),regionId=randomUUID(),reservationId=randomUUID(),taskId=randomUUID(),ownerId=randomUUID();
 return{propertyId,cityId,regionId,reservationId,taskId,ownerId,facts:{properties:new Map<string,{id:string;cityId:string|null;regionId:string|null}>([[propertyId,{id:propertyId,cityId,regionId}]]),reservations:new Map([[reservationId,{id:reservationId,propertyId}]]),tasks:new Map([[taskId,{id:taskId,propertyId,reservationId}]]),owners:new Map([[ownerId,{id:ownerId}]])}};
}
describe("percentage source scopes from retained journal facts",()=>{
 it("derives task, reservation and geography from actual tenant rows",()=>{const f=fixture();expect(employeePercentageSourceScope({task_id:f.taskId,owner_id:f.ownerId},f.facts)).toEqual({taskId:f.taskId,jobId:f.taskId,reservationId:f.reservationId,propertyId:f.propertyId,city:f.cityId,region:f.regionId,ownerId:f.ownerId});});
 it("accepts a company posting without inventing a property",()=>{const f=fixture();expect(employeePercentageSourceScope({},f.facts).propertyId).toBeUndefined();});
 it("treats absent retained dimensions as organization scope",()=>{expect(employeePercentageScopeReferences(null)).toEqual({});});
 it("retains nullable geography",()=>{const f=fixture();f.facts.properties.set(f.propertyId,{id:f.propertyId,cityId:null,regionId:null});expect(employeePercentageSourceScope({property_id:f.propertyId},f.facts)).toMatchObject({propertyId:f.propertyId,city:null,region:null});});
 it.each(["property_id","reservation_id","task_id","owner_id"] as const)("denies an unresolved or foreign %s",key=>{const f=fixture();expect(()=>employeePercentageSourceScope({[key]:randomUUID()},f.facts)).toThrow(EmployeeCompensationSourceUnavailableError);});
 it("denies inconsistent actual task and reservation references",()=>{const f=fixture(),id=randomUUID();f.facts.reservations.set(id,{id,propertyId:f.propertyId});expect(()=>employeePercentageSourceScope({task_id:f.taskId,reservation_id:id},f.facts)).toThrow(EmployeeCompensationSourceUnavailableError);});
 it("denies inconsistent actual property references",()=>{const f=fixture(),id=randomUUID();f.facts.properties.set(id,{id,cityId:f.cityId,regionId:f.regionId});expect(()=>employeePercentageSourceScope({task_id:f.taskId,property_id:id},f.facts)).toThrow(EmployeeCompensationSourceUnavailableError);});
 it("ignores entered geography labels and validates retained identity fields",()=>{const f=fixture();expect(employeePercentageScopeReferences({property_id:f.propertyId,city_id:randomUUID(),region_id:randomUUID()})).toEqual({property_id:f.propertyId});expect(()=>employeePercentageScopeReferences({property_id:"invented"})).toThrow(EmployeeCompensationSourceUnavailableError);});
 it("denies conflicting task aliases",()=>{expect(()=>employeePercentageScopeReferences({task_id:randomUUID(),job_id:randomUUID()})).toThrow(EmployeeCompensationSourceUnavailableError);});
});
