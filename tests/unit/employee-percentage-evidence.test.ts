import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {employeePercentageSourceEvidence} from "@/modules/finance/domain/employee-percentage-evidence";
import {EmployeeCompensationRunAccessError} from "@/modules/finance/domain/employee-compensation-run";
function fixture(){
 const personId=randomUUID(),policyId=randomUUID(),policy={evidence:"IMMUTABLE_POSTED_FINANCIAL_BASES",base_buckets:["PERCENTAGE_ACCEPTANCE"],base_side:"CREDIT",rate_selection:"AT_ACTUAL_BASE_INSTANT",rounding:"HALF_UP_AT_EARNING_TOTAL"};
 const row=()=>({isEarningBase:true,posting:{id:randomUUID(),amount:"0.07",currency:"MAD",bucket:"PERCENTAGE_ACCEPTANCE",side:"CREDIT",transaction:{id:randomUUID(),reference:"Actual original posted reference",occurredAt:new Date("2026-10-01T12:00:00Z")}},compensation:{id:randomUUID(),version:1,amount:"6.50",currency:"MAD",assignment:{personId}},configRule:{id:randomUUID(),version:1},policyRule:{id:policyId,version:1}});
 return{personId,currency:"MAD",amount:"0.01",sourceSnapshot:{kind:"ACTUAL_POSTED_PERCENTAGE_EARNINGS",earningPolicyRuleId:policyId,earningPolicyVersion:1,earningPolicy:policy},percentageWitnesses:[row(),row()]};
}
describe("retained original posted percentage evidence",()=>{
 it("explains exact combined earnings using actual postings and original rates",()=>{const source=fixture(),evidence=employeePercentageSourceEvidence(source);expect(evidence).toMatchObject({baseAmount:{amount:"0.14",currency:"MAD"},amount:{amount:"0.01",currency:"MAD"},baseCount:2,journalCount:2});expect(evidence.sources.map(row=>row.rate.amount)).toEqual(["6.50","6.50"]);expect(evidence.sources[0].postingId).toBe(source.percentageWitnesses[0].posting.id);});
 it("does not treat an original counterparty posting as another earning base",()=>{const source=fixture(),counterparty={...source.percentageWitnesses[0],isEarningBase:false,posting:{...source.percentageWitnesses[0].posting,id:randomUUID(),side:"DEBIT"}};source.percentageWitnesses.push(counterparty);expect(employeePercentageSourceEvidence(source).baseCount).toBe(2);});
 it("rejects a displayed earning that differs from actual original contributions",()=>{expect(()=>employeePercentageSourceEvidence({...fixture(),amount:"0.02"})).toThrow(EmployeeCompensationRunAccessError);});
 it("rejects another actual contractual beneficiary",()=>{const source=fixture();source.percentageWitnesses[0].compensation.assignment.personId=randomUUID();expect(()=>employeePercentageSourceEvidence(source)).toThrow(EmployeeCompensationRunAccessError);});
 it("rejects a different retained original policy identity",()=>{const source=fixture();source.percentageWitnesses[0].policyRule.id=randomUUID();expect(()=>employeePercentageSourceEvidence(source)).toThrow(EmployeeCompensationRunAccessError);});
 it("requires actual original earning sources",()=>{expect(()=>employeePercentageSourceEvidence({...fixture(),percentageWitnesses:[]})).toThrow(EmployeeCompensationRunAccessError);});
 it("rejects duplicate original posting identities",()=>{const source=fixture();source.percentageWitnesses[1].posting.id=source.percentageWitnesses[0].posting.id;expect(()=>employeePercentageSourceEvidence(source)).toThrow(EmployeeCompensationRunAccessError);});
});
