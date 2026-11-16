import {z} from "zod";
export const chefCompensationRequestSchema=z.object({orderId:z.uuid()}).strict();
export const chefCompensationContextSchema=z.object({orderId:z.uuid(),personId:z.uuid(),canConfigure:z.boolean(),canViewPayables:z.boolean()}).strict();
