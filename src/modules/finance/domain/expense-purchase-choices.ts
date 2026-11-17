import {z} from "zod";
export const expensePurchaseChoiceInput=z.object({propertyId:z.uuid(),reservationId:z.uuid().optional(),kind:z.enum(["PURCHASER","SUPPLIER","RECEIPT"]),query:z.string().trim().max(120).default(""),page:z.number().int().min(1).max(100000).default(1),after:z.uuid().optional()}).strict();
export const expensePurchaseChoicePage=z.object({items:z.array(z.object({id:z.uuid(),label:z.string()}).strict()).max(50),next:z.string().nullable()}).strict();
