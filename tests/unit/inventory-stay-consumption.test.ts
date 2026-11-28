import {it,expect} from "vitest";
import {inventoryStayComparison} from "@/modules/inventory/domain/stay-consumption";
it("keeps explicit zero, absent expectations and exact native consumed quantities distinct",()=>{
 expect(inventoryStayComparison({item:"linen",quantity:0,expected_per_stay:0},"9007199254740993",true,true)).toEqual({expected:"0",actual:"9007199254740993",variance:"9007199254740993"});
 expect(inventoryStayComparison({item:"linen",quantity:0},"2",true,true).expected).toBeNull();
 expect(inventoryStayComparison({item:"linen",quantity:0,expected_per_stay:7},"2",true,true)).toEqual({expected:"7",actual:"2",variance:"-5"});
 for(const [applicable,compatible]of[[false,true],[true,false]])expect(inventoryStayComparison({item:"linen",quantity:0,expected_per_stay:7},"2",applicable,compatible).expected).toBeNull();
 expect(()=>inventoryStayComparison({item:"linen",quantity:0,expected_per_stay:1.5},"2",true,true)).toThrow();
});
