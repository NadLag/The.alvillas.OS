import {z} from "zod";
/** Original purchasing evidence; personal spending is a liability, never cash. */
export const expensePurchaseSchema=z.object({fundingKind:z.enum(["COMPANY","PERSONAL"]),purchaserId:z.uuid(),supplierId:z.uuid(),receiptVersionId:z.uuid()}).strict();
export type ExpensePurchase=z.infer<typeof expensePurchaseSchema>;
