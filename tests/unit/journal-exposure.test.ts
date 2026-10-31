import {describe,expect,it} from "vitest";
import {financialJournalExposure} from "@/platform/ledger/journal-exposure";
describe("original financial journal exposure",()=>{
 it("adds exact original amounts once per journal and currency",()=>{const totals=financialJournalExposure([{transactionId:"a",currency:"MAD",amount:"1234567890123456.79"},{transactionId:"a",currency:"MAD",amount:"1234567890123456.79"},{transactionId:"b",currency:"MAD",amount:"0.01"},{transactionId:"a",currency:"EUR",amount:"7.25"}]);expect(totals.get("MAD")!.toJSON().amount).toBe("1234567890123456.80");expect(totals.get("EUR")!.toJSON().amount).toBe("7.25");});
 it("rejects inconsistent retained totals for one actual journal",()=>{expect(()=>financialJournalExposure([{transactionId:"a",currency:"MAD",amount:"1.00"},{transactionId:"a",currency:"MAD",amount:"0.01"}])).toThrow();});
 it("rejects negative source exposure",()=>{expect(()=>financialJournalExposure([{transactionId:"a",currency:"MAD",amount:"-1.00"}])).toThrow();});
});
