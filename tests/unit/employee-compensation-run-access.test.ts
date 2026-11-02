import {randomUUID} from "node:crypto";
import {beforeEach,describe,expect,it,vi} from "vitest";
import type {AuthAssignment,AuthContext,Resource} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {recheckEmployeeCompensationRun} from "@/modules/finance/application/employee-compensation-run-access";
import {EmployeeCompensationRunAccessError} from "@/modules/finance/domain/employee-compensation-run";

vi.mock("@/platform/authz/account-context",()=>({authContextForAccountInTransaction:vi.fn()}));

const organizationId=randomUUID(),actorId=randomUUID(),personId=randomUUID(),propertyId=randomUUID(),journalId=randomUUID(),at=new Date("2026-10-01T12:00:00Z"),tx={} as TenantTransaction;
const financial:Resource={type:"financial_transaction",organizationId,id:journalId,financialRecordId:journalId,propertyId,amount:"0.07",occurredAt:at,dataClass:"financial"};
const salary:Resource={type:"staff_compensation",organizationId,id:personId,assignedPersonId:personId,amount:"6.50",occurredAt:at,dataClass:"financial"};
function grants():AuthContext{
 const assignments:AuthAssignment[]=[{permissions:new Set(["employee_payable:view"]),scope:{organizationId,scopeType:"organization"}},
  {permissions:new Set(["staff_compensation:view"]),scope:{organizationId,scopeType:"organization"},conditions:{maxAmount:"10.00"}},
  {permissions:new Set(["financial_transaction:view"]),scope:{organizationId,scopeType:"organization"},conditions:{maxAmount:"35.00"}}];
 return{organizationId,userAccountId:actorId,personId,permissions:new Set(assignments.flatMap(a=>[...a.permissions])),scopes:assignments.map(a=>a.scope),assignments};
}
function facts(){return{resource:{type:"employee_payable",organizationId,amount:"2.28",dataClass:"financial" as const},total:Money.of("2.28","MAD"),
 salarySources:Array.from({length:1000},()=>({...salary})),financialSources:Array.from({length:500},()=>[{...financial},{...financial,amount:"35.00"}]).flat()};}
const held=()=>({organizationId,actorId,personId,authContext:grants()});
beforeEach(()=>{vi.resetAllMocks();vi.mocked(authContextForAccountInTransaction).mockResolvedValue(grants());});

describe("retained employee authority with repeated original resources",()=>{
 it("reloads stored grants at every boundary and rejects revocation after a successful read",async()=>{
  const ctx=held(),source=facts();await expect(recheckEmployeeCompensationRun(ctx,tx,at,source)).resolves.toBeUndefined();
  vi.mocked(authContextForAccountInTransaction).mockResolvedValue({...grants(),permissions:new Set(),assignments:[]});
  await expect(recheckEmployeeCompensationRun(ctx,tx,at,source)).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
  expect(authContextForAccountInTransaction).toHaveBeenCalledTimes(2);
 });
 it("retains a narrower held salary restriction despite broader current grants",async()=>{
  const ctx=held();ctx.authContext.assignments![1].conditions={maxAmount:"6.49"};
  await expect(recheckEmployeeCompensationRun(ctx,tx,at,facts())).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("retains whole-journal exposure when each original posting fits current authority",async()=>{
  const current=grants();current.assignments![2].conditions={maxAmount:"34.99"};vi.mocked(authContextForAccountInTransaction).mockResolvedValue(current);
  await expect(recheckEmployeeCompensationRun(held(),tx,at,facts())).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("retains every distinct original counterparty property",async()=>{
  const current=grants();current.assignments![2].scope={organizationId,scopeType:"property",scopeId:propertyId};vi.mocked(authContextForAccountInTransaction).mockResolvedValue(current);
  const source=facts();source.financialSources.push({...financial,propertyId:randomUUID()});
  await expect(recheckEmployeeCompensationRun(held(),tx,at,source)).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("retains independent original financial-record identities",async()=>{
  const current=grants();current.assignments![2].scope={organizationId,scopeType:"financial_record",scopeId:journalId};vi.mocked(authContextForAccountInTransaction).mockResolvedValue(current);
  const source=facts(),other=randomUUID();source.financialSources.push({...financial,id:other,financialRecordId:other});
  await expect(recheckEmployeeCompensationRun(held(),tx,at,source)).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("retains each actual source instant when current authority has a time restriction",async()=>{
  const current=grants();current.assignments![2].conditions={timeWindow:{endsAt:new Date(at.getTime()+1000)}};vi.mocked(authContextForAccountInTransaction).mockResolvedValue(current);
  const source=facts();source.financialSources.push({...financial,occurredAt:new Date(at.getTime()+86400000)});
  await expect(recheckEmployeeCompensationRun(held(),tx,at,source)).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("keeps correction authority independent from the same original journal view",async()=>{
  await expect(recheckEmployeeCompensationRun(held(),tx,at,facts(),"view",[{action:"void",resource:financial}])).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("retains an organization-only requirement alongside an otherwise permitted property check",async()=>{
  const current=grants();current.assignments![2].scope={organizationId,scopeType:"property",scopeId:propertyId};vi.mocked(authContextForAccountInTransaction).mockResolvedValue(current);
  await expect(recheckEmployeeCompensationRun(held(),tx,at,facts(),"view",[{action:"view",resource:financial,organizationOnly:true}])).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
 it("does not confuse distinct amount values with the same JSON representation",async()=>{
  await expect(recheckEmployeeCompensationRun(held(),tx,at,facts(),"view",[
   {action:"view",resource:{...financial,amount:Number.NaN}},
   {action:"view",resource:{...financial,amount:null}}
  ])).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
 });
});
