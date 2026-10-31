import { describe,expect,it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense } from "@/modules/finance/domain/configured-finance-rules";
import { employeeClaimPostings,employeePaymentPostings,employeeWalletOffsetPostings,type EmployeeClaimPostingLine } from "@/modules/finance/domain/employee-payable";
const money=(amount:string,currency="MAD")=>Money.of(amount,currency);
const wallet={id:"wallet",code:"WALLET_WORKER",accountType:"STAFF_WALLET",normalSide:"DEBIT",archivedAt:null,teamWallet:{id:"team-wallet",personId:"worker",person:{archivedAt:null}}};
const bank={id:"bank",code:"BANK_COMPANY",accountType:"ASSET_LOCATION",normalSide:"DEBIT",archivedAt:null};
function line(value="500.00",treatment="ALVILLAS_PAID"):EmployeeClaimPostingLine{
  const amount=money(value),allocation=allocateConfiguredExpense({default_treatment:treatment},{amount,category:"staff"});
  return{id:"cost",runLineId:"run-line",completionEventId:"completion",personId:"worker",propertyId:"property",reservationId:null,category:"staff",costCenter:null,amount,allocation,
    owners:[{ownerId:"owner",ownerName:"Owner",shareBps:10000}],ownerAmounts:[{ownerId:"owner",amount:allocation.ownerAmount}],ownerAccounts:new Map([["owner","owner-claim"]]),companyExpenseAccountId:"company-expense",guestReceivableAccountId:"guest-receivable"};
}
const base={claimId:"claim",personId:"worker",settlementId:"settlement",liabilityAccountId:"employee-claim",amount:money("450"),outstanding:money("500")};
describe("employee compensation claim and settlement posting recipes",()=>{
  it("reproduces the handbook's earned 500, wallet offset 450 and final payment 50 without booking another cost",()=>{
    const recognized=employeeClaimPostings({claimId:"claim",personId:"worker",runId:"run",liabilityAccountId:"employee-claim",amount:money("500"),lines:[line()]});
    expect(recognized.map(row=>[row.ledgerAccountId,row.side,row.amount.toJSON().amount,row.bucket])).toEqual([["company-expense","DEBIT","500.00","ALVILLAS_EXPENSE"],["employee-claim","CREDIT","500.00","EMPLOYEE_COMPENSATION"]]);
    expect(recognized[1].dimensions).toMatchObject({employee_person_id:"worker",employee_compensation_run_line_id:"run-line",completion_event_id:"completion",property_id:"property"});
    const offset=employeeWalletOffsetPostings({...base,wallet,available:money("450")});
    expect(offset.map(row=>[row.ledgerAccountId,row.side,row.amount.toJSON().amount])).toEqual([["employee-claim","DEBIT","450.00"],["wallet","CREDIT","450.00"]]);
    const paid=employeePaymentPostings({...base,amount:money("50"),outstanding:money("50"),funding:bank});
    expect(paid.map(row=>[row.ledgerAccountId,row.side,row.amount.toJSON().amount,row.bucket])).toEqual([["employee-claim","DEBIT","50.00","EMPLOYEE_PAYMENT"],["bank","CREDIT","50.00","EMPLOYEE_PAYMENT"]]);
  });
  it("uses the configured owner treatment and rejects duplicate work and unconserved totals",()=>{
    const source=line("500","OWNER_PAID"),input={claimId:"claim",personId:"worker",runId:"run",liabilityAccountId:"employee-claim",amount:money("500"),lines:[source]};
    expect(employeeClaimPostings(input)[0]).toMatchObject({ledgerAccountId:"owner-claim",side:"DEBIT",bucket:"OWNER_EXPENSE",dimensions:{owner_id:"owner"}});
    expect(()=>employeeClaimPostings({...input,lines:[source,{...source,id:"other"}]})).toThrow();
    expect(()=>employeeClaimPostings({...input,amount:money("499.99")})).toThrow();
    expect(()=>employeeClaimPostings({...input,lines:[{...source,personId:"other"}]})).toThrow();
  });
  it.each(["0","-1","450.01","500.01"])("rejects an unavailable or excessive wallet offset %s",value=>{
    expect(()=>employeeWalletOffsetPostings({...base,amount:money(value),wallet,available:money("450")})).toThrow();
  });
  it("rejects another person's wallet, a missing current wallet, mixed currency and excess payment",()=>{
    expect(()=>employeeWalletOffsetPostings({...base,wallet:{...wallet,teamWallet:{...wallet.teamWallet,personId:"other"}},available:money("450")})).toThrow();
    expect(()=>employeeWalletOffsetPostings({...base,wallet:{...wallet,archivedAt:new Date()},available:money("450")})).toThrow();
    expect(()=>employeeWalletOffsetPostings({...base,wallet,available:money("450","EUR")})).toThrow();
    expect(()=>employeePaymentPostings({...base,amount:money("500.01"),funding:bank})).toThrow();
  });
  it("requires explicit offset mode when the beneficiary retains their own wallet funds",()=>{
    expect(()=>employeePaymentPostings({...base,funding:wallet})).toThrow();
    expect(employeePaymentPostings({...base,funding:{...wallet,teamWallet:{...wallet.teamWallet,personId:"other"}}})).toHaveLength(2);
  });
  it("conserves exact minor units across real credit/debit sides for generated partial wallet offsets",()=>{
    fc.assert(fc.property(fc.bigInt({min:1n,max:9999999999999999n}),fc.integer({min:1,max:100}), (cents,percentage)=>{
      const outstanding=money((cents/100n).toString()+"."+(cents%100n).toString().padStart(2,"0")),part=outstanding.multiplyRatio(BigInt(percentage),100n);
      if(part.amount.isZero())return;
      const rows=employeeWalletOffsetPostings({...base,amount:part,outstanding,wallet,available:outstanding});
      expect(rows[0].amount.toJSON()).toEqual(rows[1].amount.toJSON());expect(outstanding.subtract(part).amount.gte(0)).toBe(true);
    }));
  });
});
