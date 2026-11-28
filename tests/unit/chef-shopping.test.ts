import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {servicePricedUnits} from "@/platform/services/priced-units";
import {chefShoppingRequirements} from "@/modules/services/domain/chef-shopping-requirements";
import {chefShoppingInputSchema} from "@/modules/services/domain/chef-shopping";
import {ownedChefMenu} from "../support/chef-menu-definition";
const ingredient=ownedChefMenu.ingredients[0],dimensions={quantity:3,guests:2,days:4};
describe("exact original Chef requirements",()=>{
 it.each([["FIXED",3n],["CUSTOM",3n],["PER_GUEST",6n],["PER_DAY",12n]])("shares the original %s pricing multiplier",(model,expected)=>expect(servicePricedUnits(model,dimensions)).toBe(expected));
 it("aggregates decimal strings without rounding or IEEE754 conversion",()=>{const id=randomUUID(),second=randomUUID(),rows=chefShoppingRequirements([{orderId:id,ingredients:[{...ingredient,quantity:"999999999999.999999"}],pricingModel:"PER_GUEST",dimensions:{quantity:Number.MAX_SAFE_INTEGER,guests:Number.MAX_SAFE_INTEGER,days:1}},{orderId:second,ingredients:[{...ingredient,quantity:"0.000001"}],pricingModel:"FIXED",dimensions:{quantity:1,guests:1,days:1}}]);const expected=(999999999999999999n*BigInt(Number.MAX_SAFE_INTEGER)**2n+1n).toString();expect(rows).toHaveLength(1);expect(rows[0].quantity).toBe((expected.slice(0,-6)+"."+expected.slice(-6)).replace(/0+$/u,""));expect(rows[0].orderIds).toEqual([id,second]);});
 it("retains distinct units and conflicting original multilingual labels",()=>{const rows=chefShoppingRequirements([{orderId:randomUUID(),ingredients:[ingredient],pricingModel:"FIXED",dimensions},{orderId:randomUUID(),ingredients:[{...ingredient,unit:{...ingredient.unit,key:"gram"}}],pricingModel:"FIXED",dimensions},{orderId:randomUUID(),ingredients:[{...ingredient,name:{...ingredient.name,ar:"مكون مختلف"}}],pricingModel:"FIXED",dimensions}]);expect(rows).toHaveLength(3);expect(rows.map(row=>row.quantity)).toEqual(["0.300003","0.300003","0.300003"]);});
 it("requires exact dimensions and a valid property/date range",()=>{expect(()=>servicePricedUnits("PER_GUEST",{...dimensions,quantity:0.1})).toThrow();expect(()=>servicePricedUnits("UNRECOGNIZED",dimensions)).toThrow();expect(chefShoppingInputSchema.safeParse({propertyId:randomUUID(),from:"2031-05-03",through:"2031-05-01"}).success).toBe(false);});
});
