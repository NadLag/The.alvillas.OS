import {it,expect} from "vitest";
import {validateLaundryPriceChange,laundryPriceChangeEvidenceSchema} from "@/modules/inventory/domain/laundry-price-change";
const basis={currency:"MAD",billing:{quantityBasis:"PLANNED" as const,billableConditions:["USABLE" as const]},prices:[{item:"linen_a",unit:"piece",amount:"15.90"},{item:"linen_b",unit:"piece",amount:"9.00"}]};
it("changes only explicitly verified affected native prices with exact Money and original billing terms",()=>{
 const changed={...basis,prices:[{...basis.prices[0],amount:"17.2"},basis.prices[1]]};expect(validateLaundryPriceChange(basis,changed,["linen_a"]).prices[0].amount).toBe("17.20");
 expect(()=>validateLaundryPriceChange(basis,changed,["linen_b"])).toThrow();
 expect(()=>validateLaundryPriceChange(basis,{...changed,currency:"EUR"},["linen_a"])).toThrow();
 expect(()=>validateLaundryPriceChange(basis,{...changed,billing:undefined},["linen_a"])).toThrow();
 expect(()=>validateLaundryPriceChange(basis,{...changed,prices:[{...changed.prices[0],unit:"kg"},basis.prices[1]]},["linen_a"])).toThrow();
 expect(()=>validateLaundryPriceChange(basis,basis,["linen_a"])).toThrow();
 expect(()=>validateLaundryPriceChange(basis,{...changed,prices:[{...changed.prices[0],amount:17.2},basis.prices[1]]},["linen_a"])).toThrow();
});
it("requires original association, price version, reviewed source fingerprint and explicit unit-rate confirmation",()=>{
 const evidence={associationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",basisVersionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",sourceFingerprint:"a".repeat(64),confirmedUnitPrices:true};expect(laundryPriceChangeEvidenceSchema.parse(evidence)).toEqual(evidence);expect(laundryPriceChangeEvidenceSchema.safeParse({...evidence,confirmedUnitPrices:false}).success).toBe(false);expect(laundryPriceChangeEvidenceSchema.safeParse({...evidence,amount:"17.20"}).success).toBe(false);
});
