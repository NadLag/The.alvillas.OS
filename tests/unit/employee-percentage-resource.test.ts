import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import type {Resource} from "@/platform/authz/authorize";
import {employeePercentageAuthorityFacts,type EmployeePercentageAuthorityWitness} from "@/platform/authz/employee-percentage-resource";
import {Money} from "@/platform/money/money";
const org=randomUUID(),person=randomUUID(),property=randomUUID(),bankProperty=randomUUID(),journal=randomUUID(),at=new Date("2026-10-01T12:00:00Z");
const contract:Resource={type:"staff_compensation",organizationId:org,id:person,assignedPersonId:person,propertyId:property,dataClass:"financial"};
function witness(isEarningBase=true):EmployeePercentageAuthorityWitness{return{isEarningBase,journalAmount:"1234.56",propertyId:isEarningBase?property:bankProperty,sourceCityId:null,sourceRegionId:null,reservationId:null,taskId:null,ownerId:null,posting:{currency:"MAD",transaction:{id:journal,occurredAt:at,createdBy:null}},compensation:{amount:"6.50",currency:"MAD",assignment:{personId:person,scopeType:"property",scopeId:property}}};}
describe("percentage history authority from typed original source witnesses",()=>{
 it("retains the whole original journal amount rather than its smaller percentage earning",()=>{const facts=employeePercentageAuthorityFacts(org,person,"MAD",Money.of("80.25","MAD"),contract,[witness()]);expect(facts.financialSources).toMatchObject([{type:"financial_transaction",financialRecordId:journal,propertyId:property,amount:"1234.56",occurredAt:at}]);});
 it("protects every original counterparty scope without adding another salary source",()=>{const facts=employeePercentageAuthorityFacts(org,person,"MAD",Money.of("80.25","MAD"),contract,[witness(),witness(false)]);expect(facts.financialSources.map(row=>row.propertyId)).toEqual([property,bankProperty]);expect(facts.salarySources).toHaveLength(4);expect(facts.salarySources.every(row=>row.propertyId===property)).toBe(true);});
 it("checks both the original rate and the whole beneficiary amount at the actual source date",()=>{const facts=employeePercentageAuthorityFacts(org,person,"MAD",Money.of("900.00","MAD"),contract,[witness()]);expect(facts.salarySources.map(row=>row.amount)).toEqual(["6.50","900.00","6.50","900.00"]);expect(facts.salarySources.every(row=>row.occurredAt===at)).toBe(true);});
 it("rejects a different actual beneficiary",()=>{expect(()=>employeePercentageAuthorityFacts(org,randomUUID(),"MAD",Money.of("80.25","MAD"),contract,[witness()])).toThrow();});
 it("rejects a different original contract currency",()=>{const row=witness();row.compensation.currency="EUR";expect(()=>employeePercentageAuthorityFacts(org,person,"MAD",Money.of("80.25","MAD"),contract,[row])).toThrow();});
});
