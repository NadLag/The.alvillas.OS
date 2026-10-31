import { z } from "zod";

export const paymentAccountSourceSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("revenue")}).strict(),
  z.object({kind:z.literal("expense"),propertyId:z.uuid(),expenseId:z.uuid().optional()}).strict()
]);
export const paymentAccountChoiceInputSchema=z.object({source:paymentAccountSourceSchema,query:z.string().trim().max(120).default(""),after:z.string().min(1).max(2048).optional(),selectedId:z.uuid().optional()}).strict();
export const paymentAccountChoicePageSchema=z.object({accounts:z.array(z.object({id:z.uuid(),name:z.string(),code:z.string()}).strict()).max(50),selected:z.object({id:z.uuid(),name:z.string(),code:z.string()}).strict().nullable(),next:z.string().min(1).max(2048).nullable()}).strict();
export type PaymentAccountSource=z.infer<typeof paymentAccountSourceSchema>;
export class PaymentAccountChoiceAccessError extends Error {}
