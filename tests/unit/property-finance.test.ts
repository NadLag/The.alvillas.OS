import {describe,expect,it} from "vitest";
import {propertyFinanceAccountPositions,propertyFinanceFilters,canViewCompletePropertyFinance,type PropertyFinanceAccountFacts} from "@/modules/finance/domain/property-finance";
import type {AuthContext} from "@/platform/authz/authorize";

const row=(input:Partial<PropertyFinanceAccountFacts>={}):PropertyFinanceAccountFacts=>({id:"10000000-0000-4000-8000-000000000001",name:"Actual property account",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT",currency:"MAD",openingDebits:"0.00",openingCredits:"0.09",periodDebits:"0.07",periodCredits:"0.00",postingCount:"2",...input});
describe("native property financial account positions",()=>{
 it("keeps the original seven-cent property expense and its exact opposite in a credit-normal claim",()=>{
  expect(propertyFinanceAccountPositions([row()])[0]).toMatchObject({opening:"0.09",debits:"0.07",credits:"0.00",closing:"0.02"});
  expect(propertyFinanceAccountPositions([row({periodCredits:"0.07",postingCount:"3"})])[0]).toMatchObject({opening:"0.09",debits:"0.07",credits:"0.07",closing:"0.09",postingCount:"3"});
 });
 it("derives the debit-normal attributed location position without combining it with money ownership",()=>{
  const rows=propertyFinanceAccountPositions([row(),row({id:"10000000-0000-4000-8000-000000000002",accountType:"ASSET_LOCATION",normalSide:"DEBIT",openingDebits:"0.07",openingCredits:"0.00",periodDebits:"0.09",periodCredits:"0.07"})]);
  expect(rows).toHaveLength(2);expect(rows[0].closing).toBe("0.02");expect(rows[1]).toMatchObject({accountType:"ASSET_LOCATION",closing:"0.09"});
 });
 it("preserves large exact amounts, independent currencies and native count precision",()=>{
  const rows=propertyFinanceAccountPositions([row({openingCredits:"123456789.07",periodDebits:"0.09",postingCount:"9007199254740993"}),row({currency:"EUR"})]);expect(rows[0]).toMatchObject({currency:"MAD",closing:"123456788.98",postingCount:"9007199254740993"});expect(rows[1]).toMatchObject({currency:"EUR",closing:"0.02"});
 });
 it("rejects duplicated account facts, signed posting magnitudes, unsupported precision and forged filters",()=>{
  expect(()=>propertyFinanceAccountPositions([row(),row()])).toThrow();expect(()=>propertyFinanceAccountPositions([row({periodDebits:"-0.07"})])).toThrow();expect(()=>propertyFinanceAccountPositions([row({periodDebits:"0.007"})])).toThrow();
  expect(propertyFinanceFilters.safeParse({propertyId:row().id,fromOn:"2026-11-02",toOn:"2026-11-01"}).success).toBe(false);expect(propertyFinanceFilters.safeParse({propertyId:row().id,organizationId:row().id}).success).toBe(false);
 });
});

describe("independent complete property financial authority",()=>{
 const organizationId="20000000-0000-4000-8000-000000000001",propertyId="20000000-0000-4000-8000-000000000002",now=new Date("2026-11-02T12:00:00Z"),target={type:"property",organizationId,id:propertyId,propertyId};
 const keys=["property:view","property_finance:view","financial_transaction:view","company_ledger:view","owner_statement:view","expense:view","supplier_invoice:view","employee_payable:view","staff_compensation:view","wallet:view","cash_collection:view","owner:view","supplier:view","team_member:view"];
 const authority=(permissions:readonly string[]=keys):AuthContext=>({organizationId,userAccountId:"20000000-0000-4000-8000-000000000003",permissions:new Set(permissions),scopes:[{organizationId,scopeType:"organization"}]});
 it("requires each independent salary, financial and party grant before showing a complete property position",()=>{
  expect(canViewCompletePropertyFinance(authority(),target,now)).toBe(true);for(const missing of["staff_compensation:view","financial_transaction:view","employee_payable:view","owner_statement:view","owner:view","supplier:view","team_member:view"]){expect(canViewCompletePropertyFinance(authority(keys.filter(key=>key!==missing)),target,now),missing).toBe(false);}
 });
 it("does not obtain complete monetary access from operational access, a role name or another tenant",()=>{
  expect(canViewCompletePropertyFinance(authority(["property:view"]),target,now)).toBe(false);const named={...authority([]),assignments:[{roleKey:"finance",permissions:new Set<string>(),scope:{organizationId,scopeType:"organization"as const}}]};expect(canViewCompletePropertyFinance(named,target,now)).toBe(false);expect(canViewCompletePropertyFinance(authority(),{...target,organizationId:propertyId},now)).toBe(false);
 });
 it("does not construct an aggregate from narrower or amount-capped grants",()=>{
  const narrowed={...authority(),assignments:[{permissions:new Set(keys),scope:{organizationId,scopeType:"property"as const,scopeId:propertyId}}]},capped={...authority(),assignments:[{permissions:new Set(keys),scope:{organizationId,scopeType:"organization"as const},conditions:{maxAmount:"999999999999.00"}}]};expect(canViewCompletePropertyFinance(narrowed,target,now)).toBe(false);expect(canViewCompletePropertyFinance(capped,target,now)).toBe(false);
 });
 it("keeps financial and salary export authority separate from viewing",()=>{
  expect(canViewCompletePropertyFinance(authority(),target,now,"export")).toBe(false);const exports=[...keys,...keys.map(key=>key.replace(":view",":export"))];expect(canViewCompletePropertyFinance(authority(exports),target,now,"export")).toBe(true);expect(canViewCompletePropertyFinance(authority(exports.filter(key=>key!=="staff_compensation:export")),target,now,"export")).toBe(false);
 });
});
