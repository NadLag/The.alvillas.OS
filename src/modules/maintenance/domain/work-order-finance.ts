import {z} from "zod";
const id=z.uuid(),money=z.object({amount:z.string().regex(/^-?\d+\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
/** References an original financial source; this record cannot post or pay it. */
export const workOrderExpenseSelectionSchema=z.object({taskId:id,expenseId:id}).strict();
export const workOrderExpenseSourceSchema=z.object({id,version:z.number().int().positive(),propertyId:id,reservationId:id.nullable(),state:z.string(),purpose:z.string(),category:z.string(),occurredOn:z.iso.date(),money,approvalId:id.nullable(),canEdit:z.boolean(),canSubmit:z.boolean()}).strict();
