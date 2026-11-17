import {z} from "zod";
import {chefMenuSchema,chefMenuTextSchema} from "@/platform/config/chef-menu-policy";
export const chefTaskRecipeSchema=chefMenuSchema.omit({chef_component_key:true});
export const chefTaskRequestSchema=z.object({taskId:z.uuid()}).strict();
export const chefTaskResponseSchema=z.object({
 taskId:z.uuid(),orderId:z.uuid(),propertyId:z.uuid(),name:chefMenuTextSchema,description:chefMenuTextSchema,
 quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),guests:z.number().int().positive(),
 serviceDate:z.iso.date(),lastServiceDate:z.iso.date(),menu:chefTaskRecipeSchema
}).strict();
