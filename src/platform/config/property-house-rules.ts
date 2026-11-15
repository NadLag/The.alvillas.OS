import {z} from "zod";

export const propertyHouseRulesMaximumCount=30;
export const propertyHouseRuleMaximumLength=180;
export const propertyHouseRulesSchema=z.array(z.string().trim().min(1).max(propertyHouseRuleMaximumLength)).max(propertyHouseRulesMaximumCount);

export function normalizeHouseRules(value:string|readonly string[]|undefined):string[]{
 const rawItems=typeof value==="string"?value.split(/\r?\n|,/u):[...(value??[])],normalized=rawItems.map(item=>item.trim()).filter((item,index,items)=>item.length>0&&items.indexOf(item)===index);
 return normalized.slice(0,propertyHouseRulesMaximumCount);
}
