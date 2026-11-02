import {describe,expect,it} from "vitest";
import fc from "fast-check";
import {receivableAccountBalances,receivablePolicySchema,receivableSummaryInput,type ReceivableAccountTotals} from "@/modules/finance/domain/receivable";

const row=(data:Partial<ReceivableAccountTotals>={}):ReceivableAccountTotals=>({id:"claim",code:"EXPLICIT_CLAIM",name:"Configured claim",accountType:"CLAIM_OWNERSHIP",normalSide:"DEBIT",currency:"MAD",opening:"0",debits:"0",credits:"0",count:"0",...data});
const amount=(cents:bigint)=>{const digits=(cents<0n?-cents:cents).toString().padStart(3,"0");return(cents<0n?"-":"")+digits.slice(0,-2)+"."+digits.slice(-2);};

describe("movement-derived receivable ownership",()=>{
  it("requires explicitly configured unique ownership account codes",()=>{
    expect(receivablePolicySchema.parse({source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["GUEST_RECEIVABLE"]})).toEqual({source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["GUEST_RECEIVABLE"]});
    for(const value of[{source:"CASH_LOCATION",account_codes:["BANK"]},{source:"POSTED_OWNERSHIP_CLAIMS",account_codes:[]},{source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["CLAIM","CLAIM"]},{source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["CLAIM"],guestId:"current-reservation-guest"}])expect(receivablePolicySchema.safeParse(value).success).toBe(false);
  });
  it("retains an exact empty position without inventing a debtor or a due date",()=>{
    expect(receivableAccountBalances([],"MAD")).toEqual({currency:"MAD",openingBalance:"0.00",periodDebits:"0.00",periodCredits:"0.00",closingBalance:"0.00",rowCount:"0",accounts:[]});
  });
  it("derives original debits and opposing credits without rewriting history or clamping credit balances",()=>{
    const rows=[row({opening:"1234.56",debits:"100.01",credits:"1334.58",count:"3"})],before=structuredClone(rows);
    expect(receivableAccountBalances(rows,"MAD")).toMatchObject({closingBalance:"-0.01",periodDebits:"100.01",periodCredits:"1334.58",rowCount:"3"});expect(rows).toEqual(before);
  });
  it("retains every cent across500 large ownership accounts and counts beyond safe integers",()=>{
    expect(receivableAccountBalances(Array.from({length:500},(_,i)=>row({id:String(i),code:"CLAIM_"+i,opening:"9999999999999999.99",debits:"0.01",count:"9007199254740993"})),"MAD")).toMatchObject({closingBalance:"5000000000000000000.00",rowCount:"4503599627370496500"});
  });
  it.each([{accountType:"ASSET_LOCATION"},{normalSide:"CREDIT"},{accountType:"ALVILLAS_OWN"},{currency:"EUR"},{debits:"-0.01"},{credits:"-1"},{count:"-1"},{count:"1.1"},{count:"01"}])("rejects inconsistent ownership evidence %j",data=>{
    expect(()=>receivableAccountBalances([row(data)],"MAD")).toThrow();
  });
  it("rejects repeated account identities and codes rather than double counting",()=>{
    expect(()=>receivableAccountBalances([row(),row({code:"DIFFERENT"})],"MAD")).toThrow();expect(()=>receivableAccountBalances([row(),row({id:"different"})],"MAD")).toThrow();
  });
  it("matches an integer-cent oracle for independently posted movements",()=>{
    fc.assert(fc.property(fc.array(fc.tuple(fc.bigInt({min:-999999999999999999n,max:999999999999999999n}),fc.bigInt({min:0n,max:999999999999999999n}),fc.bigInt({min:0n,max:999999999999999999n})),{maxLength:500}),values=>{
      const rows=values.map(([opening,debits,credits],i)=>row({id:String(i),code:"CLAIM_"+i,opening:amount(opening),debits:amount(debits),credits:amount(credits)}));
      expect(receivableAccountBalances(rows,"MAD").closingBalance).toBe(amount(values.reduce((sum,[opening,debits,credits])=>sum+opening+debits-credits,0n)));
    }),{numRuns:100});
  });
  it.each([{fromOn:"2026-02-30"},{toOn:"2026-02-28"},{currency:"mad"},{timezone:"Unknown/Zone"},{organizationId:"foreign"},{guestId:"current-guest"},{openingBalance:"123.45"},{account_codes:["UNREVIEWED_CLIENT_CHOICE"]}])("rejects client substitutions and invalid financial ranges %j",change=>{
    expect(receivableSummaryInput.safeParse({fromOn:"2026-03-01",toOn:"2026-03-31",timezone:"UTC",currency:"MAD",...change}).success).toBe(false);
  });
});
