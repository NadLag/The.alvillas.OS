import {z} from "zod";
import {chefMenuSchema,chefMenuTextSchema,chefMenuIngredientSchema} from "@/platform/config/chef-menu-policy";
export const chefTaskRecipeSchema=chefMenuSchema.omit({chef_component_key:true});
export const chefTaskRequestSchema=z.object({taskId:z.uuid()}).strict();
export const chefTaskResponseSchema=z.object({
 taskId:z.uuid(),orderId:z.uuid(),propertyId:z.uuid(),name:chefMenuTextSchema,description:chefMenuTextSchema,
 quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),guests:z.number().int().positive(),
 serviceDate:z.iso.date(),lastServiceDate:z.iso.date(),menu:chefTaskRecipeSchema,
 requirements:z.object({servings:z.string().max(100).regex(/^[1-9]\d*$/u),ingredients:z.array(chefMenuIngredientSchema.extend({quantity:z.string().max(100).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u)})).min(1).max(100)}).strict().optional()
}).strict();
