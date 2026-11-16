import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {transferRequestSchema} from "@/platform/config/transfer-order-policy";
export const transferTaskDetailsSchema=z.object({available:z.literal(true),taskId:z.uuid(),orderId:z.uuid(),propertyId:z.uuid(),name:localizedTextSchema,date:z.iso.date(),timezone:z.string().min(1).max(100),guests:z.number().int().positive(),transfer:transferRequestSchema}).strict();
export const transferTaskResponseSchema=z.discriminatedUnion("available",[transferTaskDetailsSchema,z.object({available:z.literal(false),taskId:z.uuid()}).strict()]);
