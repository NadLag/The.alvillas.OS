import { z } from "zod";
import { Money } from "@/platform/money/money";

const money=z.object({amount:z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u),currency:z.string().regex(/^[A-Z]{3}$/u)});
const allocation=z.object({owner:money,alvillas:money,guest:money});
const ownerPolicy=z.object({ownerId:z.uuid(),ownerName:z.string(),shareBps:z.number().int().min(0).max(10000),sourceAmount:money,allocation});

/** JSON object key order does not change retained terms; array membership and order do. */
export function sameSubmittedCostPolicy(actual:unknown,expected:unknown):boolean{
  if(actual===expected)return true;if(!actual||!expected||typeof actual!=="object"||typeof expected!=="object")return false;
  if(Array.isArray(actual)||Array.isArray(expected))return Array.isArray(actual)&&Array.isArray(expected)&&actual.length===expected.length&&actual.every((value,index)=>sameSubmittedCostPolicy(value,expected[index]));
  const a=actual as Record<string,unknown>,b=expected as Record<string,unknown>,keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&sameSubmittedCostPolicy(a[key],b[key]));
}

/** Read the original submitted allocation without resolving replacement agreement or cost rules. */
export function readSubmittedCostAllocation(source:{organizationId:string;propertyId:string|null;reservationId:string|null;amount:Money},raw:unknown,denied:()=>never){
  const policy=z.object({allocation,policies:z.array(z.unknown()).min(1)}).parse(raw),read=(value:z.infer<typeof money>)=>{const result=Money.of(value.amount,value.currency);if(result.currency!==source.amount.currency)denied();return result;};
  const parts={ownerAmount:read(policy.allocation.owner),alvillasAmount:read(policy.allocation.alvillas),guestAmount:read(policy.allocation.guest)};
  if(!parts.ownerAmount.add(parts.alvillasAmount).add(parts.guestAmount).equals(source.amount))denied();
  const policies=source.propertyId?z.array(ownerPolicy).min(1).parse(policy.policies):[];
  if(!source.propertyId){const company=z.array(z.object({organizationId:z.uuid()})).length(1).parse(policy.policies);
    if(company[0].organizationId!==source.organizationId||source.reservationId||!parts.ownerAmount.amount.isZero()||!parts.guestAmount.amount.isZero())denied();
  }else{
    if(new Set(policies.map(owner=>owner.ownerId)).size!==policies.length||policies.reduce((sum,owner)=>sum+owner.shareBps,0)!==10000)denied();
    let slices=Money.zero(source.amount.currency),owners=slices,company=slices,guests=slices;
    for(const owner of policies){const slice=read(owner.sourceAmount),ownerAmount=read(owner.allocation.owner),companyAmount=read(owner.allocation.alvillas),guestAmount=read(owner.allocation.guest);
      if(!ownerAmount.add(companyAmount).add(guestAmount).equals(slice))denied();slices=slices.add(slice);owners=owners.add(ownerAmount);company=company.add(companyAmount);guests=guests.add(guestAmount);
    }
    if(!slices.equals(source.amount)||!owners.equals(parts.ownerAmount)||!company.equals(parts.alvillasAmount)||!guests.equals(parts.guestAmount))denied();
  }
  if(parts.guestAmount.amount.gt(0)&&!source.reservationId)denied();
  return{allocation:parts,owners:policies.map(owner=>({ownerId:owner.ownerId,ownerName:owner.ownerName,shareBps:owner.shareBps})),ownerAmounts:policies.map(owner=>({ownerId:owner.ownerId,amount:read(owner.allocation.owner)}))};
}
