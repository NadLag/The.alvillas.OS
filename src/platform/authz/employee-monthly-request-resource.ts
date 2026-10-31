import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "./authorize";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { employeeMonthlyEarningsPolicyKey,employeeMonthlyEarningsWindow } from "@/modules/finance/domain/employee-monthly-earnings";
import { employeeMonthlyRunCreateInput,employeeMonthlyRunRequestReviewSchema } from "@/modules/finance/domain/employee-monthly-run-request";
import { EmployeeCompensationRepository } from "@/modules/finance/infrastructure/employee-compensation-repository";
import { employeeCompensationContractResource } from "@/modules/finance/application/employee-compensation-source";

export type EmployeeMonthlyRequestAuthorityRecord={id:string;requestedBy:string;requestedAt:Date;policyRuleId:string;input:unknown;review:unknown};
export type EmployeeMonthlyRequestAuthorityFacts={resource:Resource;salarySources:Resource[];legacy:boolean;sourceIdentity:string};
/** Receipt and audit permissions share actual original contract references and derive every scope from real rows. */
export async function employeeMonthlyRequestAuthorityFacts(organizationId:string,requests:readonly EmployeeMonthlyRequestAuthorityRecord[],tx:TenantTransaction){
  const policies=await new ConfigRuleRepository(tx,organizationId).findByIds(requests.map(row=>row.policyRuleId)),repository=new EmployeeCompensationRepository(tx,organizationId);
  const calendars=new Map<string,ReturnType<typeof employeeMonthlyEarningsWindow>>();
  const contexts=requests.flatMap(request=>{const input=employeeMonthlyRunCreateInput.safeParse(request.input),review=employeeMonthlyRunRequestReviewSchema.safeParse(request.review),policy=policies.get(request.policyRuleId);if(!input.success||!review.success||!policy||policy.key!==employeeMonthlyEarningsPolicyKey||policy.scopeType!=="organization"||policy.scopeId!==null)return[];try{const key=policy.id+":"+input.data.month;let window=calendars.get(key);if(!window){window=employeeMonthlyEarningsWindow(input.data.month,policy.value);calendars.set(key,window);}return[{request,input:input.data,review:review.data,window}];}catch{return[];}});
  const allEntries=contexts.flatMap(ctx=>ctx.input.assignments.flatMap(row=>ctx.window.days.map(day=>({key:row.assignmentId+":"+day.startsAt.toISOString(),assignmentId:row.assignmentId,earnedAt:day.startsAt})))),entries=[...new Map(allEntries.map(entry=>[entry.key,entry])).values()],actual=await repository.sources(entries);
  const original=await repository.originalContracts(contexts.flatMap(ctx=>ctx.review.sources?.flatMap(source=>source.days.flatMap(day=>day.compensationId?[day.compensationId]:[]))??[])),contracts=new Map(original.map(row=>[row.id,row]));
  const facts=new Map<string,EmployeeMonthlyRequestAuthorityFacts>();
  for(const ctx of contexts){const {request,input,review,window}=ctx;try{
    if(review.amount.currency!==input.currency)continue;const beneficiaries=new Map(review.beneficiaries.map(row=>[row.personId,row.amount]));let total=Money.zero(input.currency);for(const amount of beneficiaries.values())total=total.add(Money.of(amount.amount,amount.currency));if(beneficiaries.size!==review.beneficiaries.length||!total.equals(Money.of(review.amount.amount,input.currency)))continue;
    const resource:Resource={type:"employee_payable",organizationId,id:request.id,dataClass:"financial",amount:review.amount.amount,occurredAt:request.requestedAt};
    if(!review.sources){facts.set(request.id,{resource,salarySources:[{type:"staff_compensation",organizationId,dataClass:"financial"}],legacy:true,sourceIdentity:JSON.stringify({legacy:true,resource})});continue;}
    const retained=new Map(review.sources.map(row=>[row.assignmentId,row]));if(retained.size!==input.assignments.length||retained.size!==review.sources.length)continue;
    const salarySources:Resource[]=[],identity:unknown[]=[];let valid=true;
    for(const selected of input.assignments){const source=retained.get(selected.assignmentId),beneficiary=source?beneficiaries.get(source.personId):null;if(!source||!beneficiary||source.days.length!==window.days.length){valid=false;break;}const days=new Map(source.days.map(day=>[day.on,day]));if(days.size!==window.days.length){valid=false;break;}
      for(const day of window.days){const point=days.get(day.on),live=actual.get(selected.assignmentId+":"+day.startsAt.toISOString());if(!point||!live||live.assignment.personId!==source.personId||live.assignment.scopeType!==source.scopeType||live.assignment.scopeId!==source.scopeId){valid=false;break;}const contract=point.compensationId?contracts.get(point.compensationId):null;if(point.compensationId&&(!contract||contract.assignmentId!==selected.assignmentId)){valid=false;break;}
        identity.push({on:day.on,assignment:live.assignment,property:live.property,job:live.job,city:live.city,region:live.region,contract});if(contract){const originalSource={...live,rate:contract},salary=employeeCompensationContractResource(organizationId,originalSource,day.startsAt);salarySources.push(salary,{...salary,amount:beneficiary.amount});}
      }if(!valid)break;
    }
    if(valid&&salarySources.length)facts.set(request.id,{resource,salarySources,legacy:false,sourceIdentity:JSON.stringify(identity)});
  }catch{/* Invalid historical references never grant access to private request evidence. */}}
  return facts;
}
