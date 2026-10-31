import { describe,expect,it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { employeePercentageEarnedAmount,type EmployeePercentageBase } from "@/modules/finance/domain/employee-percentage-earnings";
const policy={evidence:"IMMUTABLE_POSTED_FINANCIAL_BASES",base_buckets:["ALVILLAS_COMMISSION"],base_side:"CREDIT",rate_selection:"AT_ACTUAL_BASE_INSTANT",rounding:"HALF_UP_AT_EARNING_TOTAL"};
const money=(value:string,currency="MAD")=>Money.of(value,currency);
function base(amount="500.25",rate="5.00",postingId="actual-posting"):EmployeePercentageBase{return{postingId,transactionId:"actual-transaction",bucket:"ALVILLAS_COMMISSION",side:"CREDIT",amount:money(amount),rate:money(rate)};}
const calculate=(rows:EmployeePercentageBase[],rules:unknown=policy)=>employeePercentageEarnedAmount(rules,"MAD",rows);
describe("original posted-base percentage calculation",()=>{
  it("preserves earned Money when an actual base is split into independently retained postings",()=>{fc.assert(fc.property(fc.integer({min:1,max:100000000}),fc.integer({min:1,max:100000000}),fc.integer({min:0,max:10000}),(first,second,bps)=>{const text=(cents:number)=>(BigInt(cents)/100n).toString()+"."+(BigInt(cents)%100n).toString().padStart(2,"0"),rate=text(bps),whole=calculate([base(text(first+second),rate,"whole")]),parts=calculate([base(text(first),rate,"first"),base(text(second),rate,"second")]);expect(parts.amount.equals(whole.amount)).toBe(true);expect(parts.baseAmount.equals(whole.baseAmount)).toBe(true);}),{numRuns:250});});
  it("calculates the configured original percentage exactly",()=>{const result=calculate([base()]);expect(result.amount.toJSON()).toEqual({amount:"25.01",currency:"MAD"});expect(result.baseAmount.toJSON().amount).toBe("500.25");});
  it("rounds half-cent contributions once at the complete earning total",()=>{expect(calculate([base("0.01","50.00","first"),base("0.01","50.00","second")]).amount.toJSON().amount).toBe("0.01");});
  it("retains each base's independently effective percentage",()=>{expect(calculate([base(),base("100.00","10.00","second")]).amount.toJSON().amount).toBe("35.01");});
  it("keeps large values exact without a floating intermediate",()=>{expect(calculate([base("9999999999999999.99","99.99")]).amount.toJSON().amount).toBe("9998999999999999.99");});
  it.each(["0.00","100.00"])("accepts the original contractual boundary percentage %s",rate=>{expect(calculate([base("1.00",rate)]).amount.toJSON().amount).toBe(rate==="0.00"?"0.00":"1.00");});
  it.each([
    ["missing bases",()=>[]],
    ["duplicate posting",()=>[base(),base()]],
    ["missing posting identity",()=>[{...base(),postingId:""}]],
    ["missing transaction identity",()=>[{...base(),transactionId:""}]],
    ["unconfigured bucket",()=>[{...base(),bucket:"OWNER_REVENUE"}]],
    ["opposite posting side",()=>[{...base(),side:"DEBIT" as const}]],
    ["negative base",()=>[base("-1.00")]],
    ["zero base",()=>[base("0.00")]],
    ["negative percentage",()=>[base("1.00","-0.01")]],
    ["percentage above 100",()=>[base("1.00","100.01")]],
    ["foreign base currency",()=>[{...base(),amount:money("1.00","EUR")}]],
    ["foreign rate currency",()=>[{...base(),rate:money("5.00","EUR")}]]
  ] as const)("rejects %s before returning an earning",(_name,build)=>{expect(()=>calculate(build())).toThrow();});
  it("requires explicit unambiguous base selection and rounding",()=>{expect(()=>calculate([base()],{...policy,base_buckets:[]})).toThrow();expect(()=>calculate([base()],{...policy,base_buckets:["ALVILLAS_COMMISSION","ALVILLAS_COMMISSION"]})).toThrow();expect(()=>calculate([base()],{...policy,rounding:"PER_POSTING"})).toThrow();});
});
