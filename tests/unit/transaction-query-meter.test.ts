import {describe,expect,it} from "vitest";
import {transactionQueryMeter} from "../integration/support/transaction-query-meter";

function fixture(){
  let listener!:(event:{query:string})=>void;
  const measure=transactionQueryMeter(receive=>{listener=receive;});
  return{measure,emit:(query:string)=>listener({query})};
}
describe("complete native transaction query evidence",()=>{
  it("retains an exact pool health probe separately from every statement of the complete transaction",async()=>{
    const f=fixture(),first=await f.measure(()=>{f.emit("SELECT 1");f.emit("BEGIN");f.emit("SELECT actual_source");f.emit("COMMIT");return Promise.resolve(true);}),second=await f.measure(()=>{f.emit("BEGIN");f.emit("SELECT actual_source");f.emit("COMMIT");return Promise.resolve(true);});
    expect(first.queries).toBe(3);expect(second.queries).toBe(first.queries);expect(first.connectionProbes).toBe(1);expect(second.connectionProbes).toBe(0);expect(first.queries+first.connectionProbes).toBe(4);
  });
  it("counts SELECT 1 inside the application transaction instead of hiding it as a pool probe",async()=>{
    const f=fixture(),measured=await f.measure(()=>{f.emit("BEGIN");f.emit("SELECT 1");f.emit("COMMIT");return Promise.resolve(true);});expect(measured.queries).toBe(3);expect(measured.connectionProbes).toBe(0);
  });
  it.each(["SELECT actual_source","SELECT 1 FROM actual_source","UPDATE actual_source SET value=1"])("rejects an unaccounted statement outside the application transaction: %s",async query=>{
    const f=fixture();await expect(f.measure(()=>{f.emit(query);f.emit("BEGIN");f.emit("SELECT actual_source");f.emit("COMMIT");return Promise.resolve(true);})).rejects.toThrow("One complete native transaction");
  });
  it("counts BEGIN, every source read and the actual terminal COMMIT",async()=>{
    const f=fixture(),measured=await f.measure(()=>{f.emit("BEGIN");f.emit("SELECT actual_source");f.emit("SELECT current_authority");f.emit("COMMIT");return Promise.resolve("original result");});
    expect(measured.result).toBe("original result");expect(measured.queries).toBe(4);expect(measured.elapsedMs).toBeGreaterThanOrEqual(0);
  });
  it("cannot finish when application resolution overtakes source and commit log delivery",async()=>{
    const f=fixture();let finished=false;
    const pending=f.measure(()=>{f.emit("BEGIN");f.emit("SELECT actual_source");return Promise.resolve(17);}).then(value=>{finished=true;return value;});
    await Promise.resolve();expect(finished).toBe(false);
    f.emit("SELECT final_authority");await Promise.resolve();expect(finished).toBe(false);
    f.emit("COMMIT");const measured=await pending;expect(measured.queries).toBe(4);expect(measured.result).toBe(17);
  });
  it("keeps delayed terminal events with their original measurement instead of the next page",async()=>{
    const f=fixture(),first=f.measure(()=>{f.emit("BEGIN");f.emit("SELECT one_document");return Promise.resolve(1);});
    await Promise.resolve();f.emit("COMMIT");expect((await first).queries).toBe(3);
    const second=f.measure(()=>{f.emit("BEGIN;");f.emit("SELECT twenty_documents");return Promise.resolve(20);});
    await Promise.resolve();f.emit("SELECT twenty_source_checks");f.emit(" COMMIT; ");expect((await second).queries).toBe(4);
  });
  it("rejects overlapping measurements without replacing the first transaction receipt",async()=>{
    const f=fixture(),first=f.measure(()=>{f.emit("BEGIN");f.emit("SELECT one_document");return Promise.resolve(1);});
    await expect(f.measure(()=>Promise.resolve(2))).rejects.toThrow("already active");f.emit("COMMIT");expect((await first).queries).toBe(3);
  });
  it("preserves a failing application result and releases the meter after rollback",async()=>{
    const f=fixture(),failure=new Error("Original source authority failed");
    await expect(f.measure(()=>{f.emit("BEGIN");f.emit("ROLLBACK");return Promise.reject(failure);})).rejects.toBe(failure);
    const next=await f.measure(()=>{f.emit("BEGIN");f.emit("COMMIT");return Promise.resolve(true);});expect(next.queries).toBe(2);expect(next.result).toBe(true);
  });
  it.each([{beginnings:[]},{beginnings:["BEGIN","BEGIN"]}])("rejects a partial or mixed transaction log instead of accepting its count: $beginnings",async({beginnings})=>{
    const f=fixture();await expect(f.measure(()=>{for(const query of beginnings)f.emit(query);f.emit("SELECT actual_source");f.emit("COMMIT");return Promise.resolve(true);})).rejects.toThrow("One complete native transaction");
  });
});
