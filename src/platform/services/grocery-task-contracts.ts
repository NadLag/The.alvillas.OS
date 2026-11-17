import {z} from "zod";
import {groceryItemsSchema} from "@/platform/config/grocery-order-policy";
import {taskTypeSchema} from "@/platform/config/task-type";
import {localizedTextSchema} from "@/i18n/content";
export const groceryTaskDetailsSchema=z.object({available:z.literal(true),taskId:z.uuid(),orderId:z.uuid(),propertyId:z.uuid(),taskType:taskTypeSchema,name:localizedTextSchema,items:groceryItemsSchema}).strict();
export const groceryTaskResponseSchema=z.discriminatedUnion("available",[groceryTaskDetailsSchema,z.object({available:z.literal(false),taskId:z.uuid()}).strict()]);
