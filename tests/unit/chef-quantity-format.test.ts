import {it,expect} from "vitest";
import {formatRecipeQuantity} from "@/i18n/format";
it.each([["en","999,999,999,999.999999"],["fr","999\u202f999\u202f999\u202f999,999999"],["ar","999,999,999,999.999999"]]as const)("retains every original recipe digit in %s",(locale,expected)=>expect(formatRecipeQuantity(locale,"999999999999.999999")).toBe(expected));
it("formats requirements beyond IEEE754 while retaining leading fractional zeros",()=>{expect(formatRecipeQuantity("en","81129638414606663600260857247474336318609504.000001")).toBe("81,129,638,414,606,663,600,260,857,247,474,336,318,609,504.000001");expect(formatRecipeQuantity("fr","0.000001")).toBe("0,000001");for(const value of["1e6","0.1234567","-1","1.000001 "])expect(()=>formatRecipeQuantity("en",value)).toThrow();});
