import {z} from "zod";
import {chefMenuQuantitySchema} from "./chef-menu-policy";
import {taskTypeSchema} from "./task-type";
export const groceryOrderTermsSchema=z.object({schemaVersion:z.literal(1),task_type:taskTypeSchema,purchases:z.literal("CANONICAL_PROPERTY_EXPENSE"),reimbursement:z.literal("CONFIGURED_NATIVE_SETTLEMENT")}).strict();
export const groceryItemSchema=z.object({name:z.string().trim().min(1).max(240),quantity:chefMenuQuantitySchema,unit:z.string().trim().min(1).max(80),notes:z.string().trim().max(500).optional()}).strict();
export const groceryItemsSchema=z.array(groceryItemSchema).min(1).max(100);
