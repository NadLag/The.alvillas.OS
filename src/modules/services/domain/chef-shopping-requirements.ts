import {createHash} from "node:crypto";
import {z} from "zod";
import {chefMenuIngredientSchema} from "@/platform/config/chef-menu-policy";
import {servicePricedUnits} from "@/platform/services/priced-units";
import {recipeQuantity,recipeQuantityString,type ChefShoppingItem} from "./chef-shopping";
/** Labels and units belong to immutable originals. Conflicting definitions
 * remain separate; no unconfigured conversion or stock balance is invented. */
export function chefShoppingRequirements(rows:readonly{orderId:string;ingredients:unknown;pricingModel:unknown;dimensions:unknown}[]):ChefShoppingItem[]{
 const groups=new Map<string,{item:Omit<ChefShoppingItem,"quantity">;quantity:bigint}>();
 for(const row of rows){const ingredients=z.array(chefMenuIngredientSchema).min(1).max(100).parse(row.ingredients),units=servicePricedUnits(row.pricingModel,row.dimensions);
  for(const ingredient of ingredients){const identity=JSON.stringify({key:ingredient.key,name:ingredient.name,unit:ingredient.unit}),key=createHash("sha256").update(identity).digest("hex"),current=groups.get(key)??{item:{key,name:ingredient.name,unit:ingredient.unit,orderIds:[]},quantity:0n};current.quantity+=recipeQuantity(ingredient.quantity,units);if(!current.item.orderIds.includes(row.orderId))current.item.orderIds.push(row.orderId);groups.set(key,current);}
 }
 return[...groups.values()].map(({item,quantity})=>({...item,quantity:recipeQuantityString(quantity)})).sort((a,b)=>a.key.localeCompare(b.key,"en"));
}
