import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import fc from "fast-check";
import {Money} from "@/platform/money/money";
import {receivableAssignmentPolicySchema,receivableAssignmentReviewInput,receivableAssignmentCreateInput,receivablePostedClaim,receivableUnassignedAmount,receivableOriginalPosition,type ReceivablePostedClaimSource} from "@/modules/finance/domain/receivable-assignment";

const policy={source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["EXPLICIT_ORIGINAL_CLAIM"]},now=new Date("2026-11-01T12:00:00Z");
function source(amount="1234.56"){
  const org=randomUUID(),journal=randomUUID(),account=randomUUID(),posting=randomUUID(),data:ReceivablePostedClaimSource={
    posting:{id:posting,organizationId:org,transactionId:journal,ledgerAccountId:account,side:"DEBIT",amount,currency:"MAD"},
    transaction:{id:journal,organizationId:org,occurredAt:new Date("2026-10-01T12:00:00Z"),sealed:true,reversesTransactionId:null,reversedByTransactions:[],postings:[{id:posting,ledgerAccountId:account,side:"DEBIT",amount,currency:"MAD"},{id:randomUUID(),ledgerAccountId:randomUUID(),side:"CREDIT",amount,currency:"MAD"}]},
    account:{id:account,organizationId:org,code:policy.account_codes[0],accountType:"CLAIM_OWNERSHIP",normalSide:"DEBIT"}};return{org,data};
}
const input=()=>({postingId:randomUUID(),partyKind:"GUEST",partyId:randomUUID(),amount:"1234.56",currency:"MAD",dueOn:null,purpose:"Explicit original posted claim allocation"});

describe("original receivable source assignment",()=>{
  it("accepts actual complete posted ownership evidence and preserves all original values",()=>{
    const f=source(),before=structuredClone(f.data),result=receivablePostedClaim(f.org,"MAD",policy,f.data,now);
    expect(result.amount.toJSON()).toEqual({amount:"1234.56",currency:"MAD"});expect(result.journalAmounts.get("MAD")?.toJSON().amount).toBe("1234.56");expect(f.data).toEqual(before);
  });
  it("keeps whole-journal exposure above the selected source allocation",()=>{
    const f=source("50.01");f.data.transaction.postings=[...f.data.transaction.postings,{id:randomUUID(),ledgerAccountId:randomUUID(),side:"DEBIT",amount:"50.00",currency:"MAD"},{id:randomUUID(),ledgerAccountId:randomUUID(),side:"CREDIT",amount:"50.00",currency:"MAD"}];
    const result=receivablePostedClaim(f.org,"MAD",policy,f.data,now);expect(result.amount.toJSON().amount).toBe("50.01");expect(result.journalAmounts.get("MAD")?.toJSON().amount).toBe("100.01");
  });
  it("retains source cents above safe integers without rounding or currency conversion",()=>{
    const f=source("9007199254740993.99"),result=receivablePostedClaim(f.org,"MAD",policy,f.data,now);expect(result.amount.toJSON().amount).toBe("9007199254740993.99");expect(receivableUnassignedAmount(result.amount,Money.of("9007199254740993.98","MAD")).toJSON().amount).toBe("0.01");
  });
  it.each(["posting","transaction","account"] as const)("rejects a substituted actual tenant on the %s source",key=>{
    const f=source();f.data[key].organizationId=randomUUID();expect(()=>receivablePostedClaim(f.org,"MAD",policy,f.data,now)).toThrow();
  });
  it.each(["ASSET_LOCATION","ALVILLAS_OWN","STAFF_WALLET"])("cannot reinterpret %s as an ownership claim",accountType=>{
    const f=source();f.data.account.accountType=accountType;expect(()=>receivablePostedClaim(f.org,"MAD",policy,f.data,now)).toThrow();
  });
  it("rejects reversed, opposite, future and unsealed sources without manufacturing replacement claims",()=>{
    for(const change of[{sealed:false},{reversesTransactionId:randomUUID()},{reversedByTransactions:[{id:randomUUID()}]},{occurredAt:new Date("2026-11-01T12:00:00.001Z")}]){const f=source();Object.assign(f.data.transaction,change);expect(()=>receivablePostedClaim(f.org,"MAD",policy,f.data,now)).toThrow();}
  });
  it("rejects source membership, source account, currency and full-journal substitutions",()=>{
    const f=source();for(const modify of[(s:ReceivablePostedClaimSource)=>{s.posting.id=randomUUID();},(s:ReceivablePostedClaimSource)=>{s.posting.transactionId=randomUUID();},(s:ReceivablePostedClaimSource)=>{s.posting.ledgerAccountId=randomUUID();},(s:ReceivablePostedClaimSource)=>{s.posting.currency="EUR";},(s:ReceivablePostedClaimSource)=>{s.transaction.postings=[s.transaction.postings[0]];},(s:ReceivablePostedClaimSource)=>{s.transaction.postings=[...s.transaction.postings,s.transaction.postings[0]];},(s:ReceivablePostedClaimSource)=>{s.transaction.postings=s.transaction.postings.map((row,index)=>index===1?{...row,amount:"1234.55"}:row);}]){const changed=structuredClone(f.data);modify(changed);expect(()=>receivablePostedClaim(f.org,"MAD",policy,changed,now)).toThrow();}
  });
  it.each(["0","-1","1.001","NaN","Infinity","1e3"])("rejects impossible or rounded original posting amounts %s",amount=>{
    const f=source(amount);expect(()=>receivablePostedClaim(f.org,"MAD",policy,f.data,now)).toThrow();
  });
  it("requires explicit supported party types and due-date treatment without legal defaults",()=>{
    const value={source:"ORIGINAL_POSTED_DEBIT",party_types:["GUEST","SUPPLIER"],due_date:"EXPLICIT_OR_UNSCHEDULED"};expect(receivableAssignmentPolicySchema.parse(value)).toEqual(value);
    for(const change of[{party_types:[]},{party_types:["GUEST","GUEST"]},{party_types:["CURRENT_RESERVATION_GUEST"]},{due_date:"ASSUMED_STATUTORY_DEFAULT"},{source:"CASH_LOCATION"}])expect(receivableAssignmentPolicySchema.safeParse({...value,...change}).success).toBe(false);
  });
  it("requires explicit debtor identity and scheduled or unscheduled intent",()=>{
    const value=input();expect(receivableAssignmentReviewInput.parse(value)).toEqual(value);const{dueOn,...missing}=value;expect(dueOn).toBeNull();expect(receivableAssignmentReviewInput.safeParse(missing).success).toBe(false);
    expect(receivableAssignmentCreateInput.parse({...value,idempotencyKey:randomUUID(),reviewFingerprint:"a".repeat(64),reason:"Explicit original party and posting review"})).toMatchObject(value);
  });
  it.each([{amount:0.01},{amount:"0"},{amount:"0.00"},{amount:"1.001"},{amount:"1e3"},{partyId:"current-guest"},{partyKind:"CURRENT_RESERVATION_GUEST"},{dueOn:"2026-02-30"},{organizationId:randomUUID()},{sourcePostingAmount:"9999"}])("rejects caller substitution or implicit financial intent %j",change=>{
    expect(receivableAssignmentReviewInput.safeParse({...input(),...change}).success).toBe(false);
  });
  it("retains exact unassigned cents and rejects over-allocation rather than clamping",()=>{
    expect(receivableUnassignedAmount(Money.of("100.01","MAD"),Money.of("33.33","MAD")).toJSON().amount).toBe("66.68");
    for(const assigned of[Money.of("100.02","MAD"),Money.of("-0.01","MAD"),Money.of("1","EUR")])expect(()=>receivableUnassignedAmount(Money.of("100.01","MAD"),assigned)).toThrow();
  });
  it("derives original opposites without changing party allocation or concealing a credit position",()=>{
    const allocated=Money.of("33.33","MAD"),first=randomUUID(),second=randomUUID();expect(receivableOriginalPosition(allocated,[]).toJSON().amount).toBe("33.33");expect(receivableOriginalPosition(allocated,[first]).toJSON().amount).toBe("0.00");expect(receivableOriginalPosition(allocated,[first,second]).toJSON().amount).toBe("-33.33");expect(allocated.toJSON().amount).toBe("33.33");expect(()=>receivableOriginalPosition(allocated,[first,first])).toThrow();
  });
  it("conserves original and assigned amounts against an integer-cent oracle",()=>{
    fc.assert(fc.property(fc.bigInt({min:1n,max:999999999999999999n}),fc.bigInt({min:0n,max:999999999999999999n}),(original,candidate)=>{
      const assigned=candidate%original,toMoney=(value:bigint)=>Money.of((value/100n).toString()+"."+(value%100n).toString().padStart(2,"0"),"MAD");expect(receivableUnassignedAmount(toMoney(original),toMoney(assigned)).add(toMoney(assigned)).equals(toMoney(original))).toBe(true);
    }),{numRuns:200});
  });
});
