import {z} from "zod";
import {Money} from "@/platform/money/money";
import {laundrySupplierPricePolicySchema,laundryInvoiceQuantityBasisSchema} from "@/platform/config/laundry-pricing-policy";
import {stockQuantitySchema} from "./stocktake";
import {configSlugSchema} from "@/platform/config/identifiers";
import {InventoryCatalogDefinitionError} from "./catalog-errors";
const id=z.uuid(),quantity=stockQuantitySchema.refine(value=>BigInt(value)>=0n),condition=z.enum(["USABLE","DAMAGED"]);
export const expectedLaundryInvoiceSourceSchema=z.object({finalized:z.boolean(),lines:z.array(z.object({id,itemId:id,itemKey:configSlugSchema,unit:z.string().min(1).max(60),condition,quantity:quantity.refine(value=>BigInt(value)>0n)}).strict()).min(1).max(50),usage:z.array(z.object({lineId:id,basis:laundryInvoiceQuantityBasisSchema.exclude(["PLANNED"]),condition,quantity}).strict()).max(300)}).strict();
export function calculateExpectedLaundryInvoice(rawPolicy:unknown,rawSource:unknown){
 const policy=laundrySupplierPricePolicySchema.parse(rawPolicy),source=expectedLaundryInvoiceSourceSchema.parse(rawSource),identities=new Map(source.lines.map(line=>[line.id,line])),seen=new Set<string>(),totals=new Map<string,bigint>();if(identities.size!==source.lines.length||new Set(source.lines.map(line=>line.itemId+":"+line.condition)).size!==source.lines.length)throw new InventoryCatalogDefinitionError();
 for(const row of source.usage){const line=identities.get(row.lineId),key=row.lineId+":"+row.basis+":"+row.condition,scope=row.lineId+":"+row.basis,total=(totals.get(scope)??0n)+BigInt(row.quantity);if(!line||seen.has(key)||total>BigInt(line.quantity))throw new InventoryCatalogDefinitionError();seen.add(key);totals.set(scope,total);}
 if(!policy.billing)return{status:"NEEDS_TERMS"as const,currency:policy.currency,total:null,lines:[]};
 const billing=policy.billing,prices=new Map(policy.prices.map(row=>[row.item,row])),rows=[],missing=new Set<string>();let total=Money.zero(policy.currency),pending=false;
 for(const line of source.lines){const usage=billing.quantityBasis==="PLANNED"?[{condition:line.condition,quantity:line.quantity}]:source.usage.filter(row=>row.lineId===line.id&&row.basis===billing.quantityBasis),rawQuantity=usage.reduce((sum,row)=>sum+BigInt(row.quantity),0n);if(!source.finalized&&billing.quantityBasis!=="PLANNED"&&rawQuantity<BigInt(line.quantity))pending=true;
  for(const row of usage){const billable=billing.billableConditions.includes(row.condition),count=billable?BigInt(row.quantity):0n,price=prices.get(line.itemKey);if(count>0n&&(!price||price.unit!==line.unit)){missing.add(line.id);rows.push({lineId:line.id,itemId:line.itemId,itemKey:line.itemKey,condition:row.condition,unit:line.unit,quantity:row.quantity,billable,unitPrice:price?.amount??null,total:null,issue:price?"UNIT_MISMATCH"as const:"MISSING_PRICE"as const});continue;}
   const amount=count===0n?Money.zero(policy.currency):Money.of(price!.amount,policy.currency).multiplyRatio(count,1n);total=total.add(amount);rows.push({lineId:line.id,itemId:line.itemId,itemKey:line.itemKey,condition:row.condition,unit:line.unit,quantity:row.quantity,billable,unitPrice:price?.amount??null,total:amount.toJSON().amount,issue:null});
  }
 }
 return{status:missing.size?"NEEDS_PRICE"as const:pending?"PROVISIONAL"as const:"READY"as const,currency:policy.currency,total:missing.size?null:total.toJSON().amount,lines:rows};
}
