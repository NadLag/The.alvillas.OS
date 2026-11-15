import {describe,it,expect} from "vitest";
import ar from "../../messages/ar.json";

describe("house-rules Arabic history encoding",()=>{
 it("retains readable Arabic for every immutable acceptance-history control",()=>{
  for(const [key,text]of Object.entries(ar.GuestHouseRulesManagement).filter(([key])=>key.startsWith("history"))){
   expect(text,key).toMatch(/[\u0600-\u06ff]/u);
   expect(text,key).not.toMatch(/\?{2,}|\ufffd/u);
  }
 });
});
