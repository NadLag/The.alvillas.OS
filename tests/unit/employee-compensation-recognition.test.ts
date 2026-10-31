import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {employeeCompensationRecognitionCosts,type EmployeeCompensationRecognitionSource} from "@/modules/finance/domain/employee-compensation-recognition";
import {employeeClaimPostings} from "@/modules/finance/domain/employee-payable";

const money=(amount:string)=>({amount,currency:"MAD"});
function fixture(on="2026-10-30"){
  const organizationId=randomUUID(),id=randomUUID(),runId=randomUUID() as string,claimId=randomUUID(),personId=randomUUID(),costId=randomUUID(),lineId=randomUUID(),taskId=randomUUID(),eventId=randomUUID(),propertyId=randomUUID(),owners=[randomUUID(),randomUUID()],at=`${on}T12:00:00.000Z`;
  const allocation={owner:money("500.25"),alvillas:money("0.00"),guest:money("0.00")},policy={schemaVersion:1,sourceKind:"employee_compensation_run_line",runId,runLineId:lineId,completionEventId:eventId,personId,recordedCompletionAt:at,propertyId,reservationId:null,occurredOn:on,timezone:"Africa/Casablanca",category:"staff",amount:money("500.25"),allocation,
    policies:owners.map((ownerId,index)=>({ownerId,ownerName:"Original cost owner",shareBps:5000,sourceAmount:money(index?"250.12":"250.13"),allocation:{owner:money(index?"250.12":"250.13"),alvillas:money("0.00"),guest:money("0.00")}}))};
  const source:EmployeeCompensationRecognitionSource={organizationId,id,runId,costOn:on,currency:"MAD",emergency:false,claims:[{id:claimId,organizationId,submissionId:id,personId}],
    runLines:[{id:lineId,personId,propertyId,taskId,completionEventId:eventId,recordedCompletionAt:at,amount:"500.25",currency:"MAD"}],
    costs:[{id:costId,organizationId,submissionId:id,claimId,runLineId:lineId,completionEventId:eventId,propertyId,reservationId:null,amount:"500.25",currency:"MAD",category:"staff",costCenter:null,note:"Original contracted work cost",timezone:"Africa/Casablanca",policySnapshot:structuredClone(policy)}]};
  const snapshot={schemaVersion:1,kind:"EMPLOYEE_COMPENSATION_COSTS",runId,costOn:on,total:money("500.25"),costs:[{runLineId:lineId,personId,propertyId,reservationId:null,taskId,completionEventId:eventId,recordedCompletionAt:at,costOn:on,timezone:"Africa/Casablanca",category:"staff",costCenter:null,note:"Original contracted work cost",amount:money("500.25"),policy}]};
  return{source,snapshot,claimId,personId,owners};
}

describe("original employee cost recognition source",()=>{
  it("retains the original performer, owner rounding and property calendar in a balanced earned claim",()=>{
    const f=fixture(),retained=employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot);
    expect(retained.personId).toBe(f.personId);expect(retained.amount.toJSON()).toEqual(money("500.25"));expect(retained.costs[0].ownerAmounts.map(row=>row.amount.toJSON().amount)).toEqual(["250.13","250.12"]);
    expect(retained.costs[0].sourceOccurredAt.toISOString()).toBe("2026-10-30T00:00:00.000Z");
    const postings=employeeClaimPostings({claimId:f.claimId,personId:f.personId,runId:f.source.runId,liabilityAccountId:"employee-liability",amount:retained.amount,
      lines:retained.costs.map(cost=>({...cost,ownerAccounts:new Map(f.owners.map(owner=>[owner,"owner-claim"])),companyExpenseAccountId:"company",guestReceivableAccountId:"guest"}))});
    expect(postings.map(row=>[row.side,row.amount.toJSON().amount,row.bucket])).toEqual([["DEBIT","250.13","OWNER_EXPENSE"],["DEBIT","250.12","OWNER_EXPENSE"],["CREDIT","500.25","EMPLOYEE_COMPENSATION"]]);
  });
  it.each([["2026-09-19","2026-09-18T23:00:00.000Z"],["2026-09-21","2026-09-21T00:00:00.000Z"]])("uses the property's actual calendar offset for %s",(day,start)=>{
    const f=fixture(day);expect(employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot).costs[0].sourceOccurredAt.toISOString()).toBe(start);
  });
  it("selects only the actual person's claim after validating every submitted beneficiary",()=>{
    const f=fixture(),second=fixture(),cost=second.source.costs[0],claim=second.source.claims[0],line=second.snapshot.costs[0];
    second.source.claims=[{...claim,organizationId:f.source.organizationId,submissionId:f.source.id}];
    second.source.costs=[{...cost,organizationId:f.source.organizationId,submissionId:f.source.id,policySnapshot:{...line.policy,runId:f.source.runId}}];
    f.source.claims=[...f.source.claims,...second.source.claims];f.source.runLines=[...f.source.runLines,...second.source.runLines];f.source.costs=[...f.source.costs,...second.source.costs];
    f.snapshot.total=money("1000.50");f.snapshot.costs.push({...line,policy:{...line.policy,runId:f.source.runId}});
    const retained=employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot);
    expect(retained.amount.toJSON()).toEqual(money("500.25"));expect(retained.costs.map(value=>value.personId)).toEqual([f.personId]);
    f.source.costs=f.source.costs.map((value,index)=>index?{...value,completionEventId:randomUUID()}:value);expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();
  });
  it.each(["runId","costOn"] as const)("rejects a changed submitted %s",key=>{const f=fixture();f.snapshot[key]=key==="runId"?randomUUID():"2026-10-29";expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();});
  it("rejects another claim, performer, tenant or submission",()=>{
    for(const change of[(f:ReturnType<typeof fixture>)=>{f.source.claims=[{...f.source.claims[0],personId:randomUUID()}];},
      (f:ReturnType<typeof fixture>)=>{f.source.costs=[{...f.source.costs[0],organizationId:randomUUID()}];},
      (f:ReturnType<typeof fixture>)=>{f.source.costs=[{...f.source.costs[0],submissionId:randomUUID()}];},
      (f:ReturnType<typeof fixture>)=>{f.source.claims=[{...f.source.claims[0],submissionId:randomUUID()}];}]){const f=fixture();change(f);expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();}
    const f=fixture();expect(()=>employeeCompensationRecognitionCosts(f.source,randomUUID(),f.snapshot)).toThrow();
  });
  it("rejects changed completion evidence, category, calendar and original source amounts",()=>{
    for(const change of[(f:ReturnType<typeof fixture>)=>{f.snapshot.costs[0].completionEventId=randomUUID();},(f:ReturnType<typeof fixture>)=>{f.snapshot.costs[0].category="other";},
      (f:ReturnType<typeof fixture>)=>{f.snapshot.costs[0].recordedCompletionAt="2026-10-30T13:00:00.000Z";},(f:ReturnType<typeof fixture>)=>{f.snapshot.costs[0].amount.amount="500.24";},
      (f:ReturnType<typeof fixture>)=>{f.source.costs=[{...f.source.costs[0],currency:"USD"}];}]){const f=fixture();change(f);expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();}
  });
  it("rejects a replacement allocation even when the replacement still balances",()=>{
    const f=fixture(),replacement=structuredClone(f.snapshot.costs[0].policy);replacement.allocation={owner:money("0.00"),alvillas:money("500.25"),guest:money("0.00")};
    f.source.costs=[{...f.source.costs[0],policySnapshot:replacement}];expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();
  });
  it("accepts the same frozen policy with different JSON object key order",()=>{
    const f=fixture(),policy=f.snapshot.costs[0].policy;f.source.costs=[{...f.source.costs[0],policySnapshot:Object.fromEntries(Object.entries(policy).reverse())}];
    expect(employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot).amount.toJSON()).toEqual(money("500.25"));
  });
  it("rejects missing, duplicate and redistributed actual cost identities",()=>{
    for(const change of[(f:ReturnType<typeof fixture>)=>{f.source.costs=[];},(f:ReturnType<typeof fixture>)=>{f.source.costs=[...f.source.costs,f.source.costs[0]];},
      (f:ReturnType<typeof fixture>)=>{f.snapshot.costs[0].policy.policies[0].allocation.owner.amount="250.12";f.snapshot.costs[0].policy.policies[0].allocation.alvillas.amount="0.01";f.source.costs=[{...f.source.costs[0],policySnapshot:structuredClone(f.snapshot.costs[0].policy)}];}]){const f=fixture();change(f);expect(()=>employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot)).toThrow();}
  });
  it("conserves 500 original cost lines whose complete earned claim exceeds individual storage precision",()=>{
    const f=fixture(),value="9999999999999999.99",template=f.snapshot.costs[0],actual=f.source.costs[0],original=f.source.runLines[0],copies=Array.from({length:500},()=>{
      const runLineId=randomUUID(),completionEventId=randomUUID(),taskId=randomUUID(),policy=structuredClone(template.policy);policy.runLineId=runLineId;policy.completionEventId=completionEventId;policy.amount=money(value);policy.allocation.owner=money(value);
      policy.policies.forEach((owner,index)=>{const slice=index?"4999999999999999.99":"5000000000000000.00";owner.sourceAmount=money(slice);owner.allocation.owner=money(slice);});
      return{line:{...original,id:runLineId,completionEventId,taskId,amount:value},cost:{...actual,id:randomUUID(),runLineId,completionEventId,amount:value,policySnapshot:structuredClone(policy)},frozen:{...template,runLineId,completionEventId,taskId,amount:money(value),policy}};
    });
    f.source.runLines=copies.map(copy=>copy.line);f.source.costs=copies.map(copy=>copy.cost);f.snapshot.costs=copies.map(copy=>copy.frozen);f.snapshot.total=money("4999999999999999995.00");
    const retained=employeeCompensationRecognitionCosts(f.source,f.claimId,f.snapshot);expect(retained.amount.toJSON()).toEqual(f.snapshot.total);expect(retained.costs).toHaveLength(500);
  });
});
