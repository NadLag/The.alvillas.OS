import {z} from "zod";
import {configSlugSchema} from "@/platform/config/identifiers";

export const serviceOrderStates=["REQUESTED","QUOTED","CONFIRMED","IN_PROGRESS","FULFILLED","REJECTED","CANCELLED"]as const;
export const serviceOrderStateSchema=z.enum(serviceOrderStates);
export type ServiceOrderState=z.infer<typeof serviceOrderStateSchema>;
export const terminalServiceOrderStates:readonly ServiceOrderState[]=["FULFILLED","REJECTED","CANCELLED"];
const transitions:Record<ServiceOrderState,readonly ServiceOrderState[]>={REQUESTED:["QUOTED","CONFIRMED","REJECTED","CANCELLED"],QUOTED:["QUOTED","CONFIRMED","REJECTED","CANCELLED"],CONFIRMED:["IN_PROGRESS","FULFILLED","CANCELLED"],IN_PROGRESS:["FULFILLED","CANCELLED"],FULFILLED:[],REJECTED:[],CANCELLED:[]};
export function canTransitionServiceOrder(from:ServiceOrderState,to:ServiceOrderState){return transitions[from].includes(to);}

export const serviceOrderPositiveInteger=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const serviceOrderReasonSchema=z.string().trim().min(6).max(500);
export const serviceOrderRequestSchema=z.object({
 propertyId:z.uuid(),reservationId:z.uuid(),serviceKey:configSlugSchema,
 serviceDate:z.iso.date(),lastServiceDate:z.iso.date(),quantity:serviceOrderPositiveInteger,guests:serviceOrderPositiveInteger,
 reason:serviceOrderReasonSchema
}).strict().refine(value=>value.lastServiceDate>=value.serviceDate,{path:["lastServiceDate"],message:"service_order_invalid_dates"});
export type ServiceOrderRequest=z.infer<typeof serviceOrderRequestSchema>;
