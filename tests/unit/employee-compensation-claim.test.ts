import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { employeeCompensationClaimPolicyInput,employeeCompensationClaimCosts,EmployeeCompensationClaimSourceError } from "@/modules/finance/domain/employee-compensation-claim";
const runId=randomUUID(),a=randomUUID(),b=randomUUID();
const input={runId,costOn:"2026-10-30",emergency:false,costs:[{runLineId:a,category:"staff",costCenter:null,note:"Classify actual completed work for configured review"}]};
describe("retained employee work cost classification",()=>{
  it("retains exact original money while an explicit classification supplies no replacement amount or currency",()=>{
    const parsed=employeeCompensationClaimPolicyInput.parse(input),source={id:a,amount:"500.25",currency:"MAD"},plan=employeeCompensationClaimCosts(parsed,[source],"MAD");
    expect(plan.costs[0].source).toBe(source);expect(plan.total.toJSON()).toEqual({amount:"500.25",currency:"MAD"});
    expect(employeeCompensationClaimPolicyInput.safeParse({...input,costs:[{...input.costs[0],amount:"1.00"}]}).success).toBe(false);
    expect(employeeCompensationClaimPolicyInput.safeParse({...input,currency:"EUR"}).success).toBe(false);
  });
  it("rejects omitted, foreign and duplicated positive work sources",()=>{
    const source={id:a,amount:"500.25",currency:"MAD"};
    expect(()=>employeeCompensationClaimCosts(input,[source,{...source,id:b}],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
    expect(()=>employeeCompensationClaimCosts({...input,costs:[{...input.costs[0],runLineId:b}]},[source],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
    expect(()=>employeeCompensationClaimCosts({...input,costs:[input.costs[0],input.costs[0]]},[source,{...source,id:b}],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
  });
  it("keeps zero-valued contractual work in the original run while claiming every positive source",()=>{
    const plan=employeeCompensationClaimCosts(input,[{id:a,amount:"500.25",currency:"MAD"},{id:b,amount:"0.00",currency:"MAD"}],"MAD");
    expect(plan.costs).toHaveLength(1);expect(plan.total.toJSON().amount).toBe("500.25");
    expect(()=>employeeCompensationClaimCosts(input,[{id:a,amount:"0.00",currency:"MAD"}],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
  });
  it("rejects negative or mixed-currency retained source money",()=>{
    expect(()=>employeeCompensationClaimCosts(input,[{id:a,amount:"-0.01",currency:"MAD"}],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
    expect(()=>employeeCompensationClaimCosts(input,[{id:a,amount:"500.25",currency:"EUR"}],"MAD")).toThrow(EmployeeCompensationClaimSourceError);
  });
});
