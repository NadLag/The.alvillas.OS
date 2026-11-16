import {z} from "zod";
import {chefMenuTextSchema} from "@/platform/config/chef-menu-policy";
export const chefShoppingInputSchema=z.object({propertyId:z.uuid(),from:z.iso.date(),through:z.iso.date()}).strict().refine(value=>value.from<=value.through);
const exactQuantity=z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u).max(100);
export const chefShoppingResponseSchema=z.object({propertyId:z.uuid(),from:z.iso.date(),through:z.iso.date(),generatedAt:z.iso.datetime(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),orders:z.array(z.object({id:z.uuid(),name:chefMenuTextSchema,serviceDate:z.iso.date(),lastServiceDate:z.iso.date(),state:z.enum(["REQUESTED","QUOTED","CONFIRMED"]),pricedUnits:z.string().regex(/^[1-9]\d*$/u),servings:z.string().regex(/^[1-9]\d*$/u)}).strict()).max(500),items:z.array(z.object({key:z.string(),name:chefMenuTextSchema,unit:z.object({key:z.string(),name:chefMenuTextSchema}).strict(),quantity:exactQuantity,orderIds:z.array(z.uuid()).max(500)}).strict()).max(50000)}).strict();
export type ChefShoppingItem=z.infer<typeof chefShoppingResponseSchema>["items"][number];
export {recipeQuantity,recipeQuantityString} from "@/platform/services/recipe-quantity";
