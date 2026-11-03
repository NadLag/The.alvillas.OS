import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {Money} from "@/platform/money/money";
import {buildServiceAllocationSnapshot} from "@/modules/finance/domain/service-allocation-snapshot";
import type {ServiceAllocationRecipe} from "@/platform/config/service-allocation-policy";

function fixture(){
 const recipe:ServiceAllocationRecipe={service_key:"private_chef",currency:"MAD",basis:"COLLECTED_GROSS_LESS_FIXED_COMPONENTS",rounding:"LARGEST_REMAINDER",provider_treatment:"REVENUE_WITH_EXISTING_COMPANY_COST",components:[{key:"provider",beneficiary:"PERSON",mode:"FIXED",amount:"700.00"},{key:"owner",beneficiary:"OWNER",mode:"BASIS_POINTS",basis_points:2000},{key:"company",beneficiary:"COMPANY",mode:"REMAINDER"}],rounding_priority:["owner","company"],tax_rule_keys:["approved_tax"]};
 return{source:{kind:"COMPLETED_SERVICE_COLLECTION"as const,collectionId:randomUUID(),transactionId:randomUUID(),taskId:randomUUID(),propertyId:randomUUID(),reservationId:null,completionEventId:randomUUID(),performedByPersonId:randomUUID(),completedAt:"2026-11-01T10:00:00.000Z",recordedAt:"2026-11-01T09:00:00.000Z",currencyMinorUnit:2},gross:Money.of("1200","MAD"),serviceKey:"private_chef",allocationRule:{id:randomUUID(),key:"finance.service_allocation",version:4,value:{source:"COMPLETED_SERVICE_COLLECTION",rule_selection:"AT_ACTUAL_SERVICE_COMPLETION",ownership_basis:"CURRENT_PROPERTY_OWNERS_AT_ADMISSION",services:[recipe,{...recipe,service_key:"unrelated_private_service",components:[{key:"unrelated_private_margin",beneficiary:"COMPANY",mode:"REMAINDER"}],rounding_priority:["unrelated_private_margin"]}]}},taxRule:{id:randomUUID(),key:"finance.tax",version:7,value:{taxes:[{key:"approved_tax",currency:"MAD",amount:"0.00",service_assessment:{basis:"ACTUAL_COLLECTED_GROSS",method:"FIXED",rounding:"HALF_UP_AT_LEDGER_PRECISION"}},{key:"unrelated_private_tax",rate_bps:7183}]}},owners:[{ownerId:randomUUID(),ownerName:"Actual owner",shareBps:10000}],providerCosts:[{componentKey:"provider",bindingId:randomUUID(),sourceKind:"EMPLOYEE_COST"as const,costId:randomUUID(),transactionId:randomUUID(),partyId:randomUUID(),amount:Money.of("700","MAD")}]};
}
describe("immutable selected service admission snapshot",()=>{
 it("retains exact source, policy versions and configured tax treatment without copying unrelated financial catalogs",()=>{
  const input=fixture(),result=buildServiceAllocationSnapshot(input),json=JSON.stringify(result.snapshot);
  expect(result.snapshot.source.amount).toEqual({amount:"1200.00",currency:"MAD"});expect(result.snapshot.rules).toMatchObject({allocation:{id:input.allocationRule.id,version:4,ownershipBasis:"CURRENT_PROPERTY_OWNERS_AT_ADMISSION"},tax:{id:input.taxRule.id,version:7}});
  expect(result.snapshot.taxes[0]).toMatchObject({configuredValue:{amount:"0.00"},amount:{amount:"0.00",currency:"MAD"},policyVersion:7});
  expect(json).not.toContain("unrelated_private");expect(json).not.toContain("7183");expect(result.snapshot.parts.map(part=>part.amount.amount)).toEqual(["700.00","100.00","400.00"]);expect(result.snapshot.providerCosts[0].transactionId).toBe(input.providerCosts[0].transactionId);
 });
 it("has a stable review identity that changes with original source, policy, ownership or native provider evidence",()=>{
  const input=fixture(),first=buildServiceAllocationSnapshot(input);expect(buildServiceAllocationSnapshot(input).fingerprint).toBe(first.fingerprint);
  for(const changed of[{...input,source:{...input.source,transactionId:randomUUID()}},{...input,allocationRule:{...input.allocationRule,version:5}},{...input,owners:[{...input.owners[0],ownerId:randomUUID()}]},{...input,providerCosts:[{...input.providerCosts[0],bindingId:randomUUID()}]}])expect(buildServiceAllocationSnapshot(changed).fingerprint).not.toBe(first.fingerprint);
 });
 it("rejects missing, duplicated, wrong-kind, repriced or wrong-currency provider evidence",()=>{
  const input=fixture();for(const costs of[[],[...input.providerCosts,...input.providerCosts],[{...input.providerCosts[0],sourceKind:"SUPPLIER_INVOICE_LINE"as const}],[{...input.providerCosts[0],amount:Money.of("699.99","MAD")}],[{...input.providerCosts[0],amount:Money.of("700","EUR")}],[{...input.providerCosts[0],componentKey:"invented"}]])expect(()=>buildServiceAllocationSnapshot({...input,providerCosts:costs})).toThrow();
 });
 it("requires the complete exact ownership evidence and rejects missing or substituted policy identities",()=>{
  const input=fixture();for(const owners of[[],[{...input.owners[0],shareBps:9999}],[{...input.owners[0],shareBps:5000},{...input.owners[0],shareBps:5000}]])expect(()=>buildServiceAllocationSnapshot({...input,owners})).toThrow();
  expect(()=>buildServiceAllocationSnapshot({...input,allocationRule:{...input.allocationRule,key:"finance.tax"}})).toThrow();expect(()=>buildServiceAllocationSnapshot({...input,serviceKey:"missing"})).toThrow();
 });
 it("does not invent provider obligations or expose owners when their configured allocation is zero",()=>{
  const input=fixture();input.allocationRule.value.services[0].components=[{key:"company",beneficiary:"COMPANY",mode:"REMAINDER"}];input.allocationRule.value.services[0].rounding_priority=["company"];
  const result=buildServiceAllocationSnapshot({...input,providerCosts:[]});expect(result.snapshot.owners).toEqual([]);expect(result.snapshot.providerCosts).toEqual([]);expect(result.snapshot.parts).toHaveLength(1);expect(result.snapshot.parts[0].amount.amount).toBe("1200.00");
 });
});
