import {z} from "zod";
import {configSlugSchema} from "@/platform/config/identifiers";
import {serviceCatalogAmountSchema} from "@/platform/config/service-catalog-policy";
import {serviceOrderPolicySchema,type ServiceOrderPolicy} from "@/platform/config/service-order-policy";
import {evaluate} from "@/platform/automation/rule";
import {Money} from "@/platform/money/money";
import {serviceCatalogPrice,type ServiceCatalogEntry} from "./service-catalog";

export class ServiceOrderAccessError extends Error {}
export class ServiceOrderConflictError extends Error {}
export class ServiceOrderSourceUnavailableError extends Error {}
export class ServiceOrderConfigurationError extends Error {}
export class ServiceOrderValidationError extends Error {}

export const serviceOrderStates=["REQUESTED","QUOTED","CONFIRMED","IN_PROGRESS","FULFILLED","REJECTED","CANCELLED"]as const;
export const serviceOrderStateSchema=z.enum(serviceOrderStates);
export type ServiceOrderState=z.infer<typeof serviceOrderStateSchema>;
export const terminalServiceOrderStates:readonly ServiceOrderState[]=["FULFILLED","REJECTED","CANCELLED"];
const transitions:Record<ServiceOrderState,readonly ServiceOrderState[]>={
 REQUESTED:["QUOTED","CONFIRMED","REJECTED","CANCELLED"],
 QUOTED:["QUOTED","CONFIRMED","REJECTED","CANCELLED"],
 CONFIRMED:["IN_PROGRESS","CANCELLED"],
 IN_PROGRESS:["FULFILLED","CANCELLED"],
 FULFILLED:[],REJECTED:[],CANCELLED:[]
};
export function canTransitionServiceOrder(from:ServiceOrderState,to:ServiceOrderState){return transitions[from].includes(to);}

const positiveInteger=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const serviceOrderReasonSchema=z.string().trim().min(6).max(500);
export const serviceOrderRequestSchema=z.object({
 propertyId:z.uuid(),reservationId:z.uuid(),serviceKey:configSlugSchema,
 serviceDate:z.iso.date(),lastServiceDate:z.iso.date(),quantity:positiveInteger,guests:positiveInteger,
 reason:serviceOrderReasonSchema
}).strict().refine(value=>value.lastServiceDate>=value.serviceDate,{path:["lastServiceDate"],message:"service_order_invalid_dates"});
export type ServiceOrderRequest=z.infer<typeof serviceOrderRequestSchema>;
export const serviceOrderCreateSchema=z.object({request:serviceOrderRequestSchema,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),idempotencyKey:z.uuid()}).strict();
export const serviceOrderQuoteSchema=z.object({amount:serviceCatalogAmountSchema,currency:z.string().regex(/^[A-Z]{3}$/u),approvalReference:z.string().trim().min(1).max(240)}).strict();
export const serviceOrderTransitionSchema=z.object({
 orderId:z.uuid(),expectedVersion:positiveInteger,state:serviceOrderStateSchema,
 quote:serviceOrderQuoteSchema.optional(),reason:serviceOrderReasonSchema,
 reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),idempotencyKey:z.uuid()
}).strict().superRefine((value,context)=>{
 if((value.state==="QUOTED")!==(value.quote!==undefined))context.addIssue({code:"custom",path:["quote"],message:"service_order_explicit_quote_required"});
 if(value.state==="REQUESTED")context.addIssue({code:"custom",path:["state"],message:"service_order_request_is_birth_only"});
});
export const serviceOrderRecoverSchema=z.object({propertyId:z.uuid(),reservationId:z.uuid(),idempotencyKey:z.uuid()}).strict();
export const serviceOrderPageSchema=z.object({propertyId:z.uuid(),reservationId:z.uuid().optional(),state:serviceOrderStateSchema.optional(),after:z.uuid().optional()}).strict();

export type ServiceOrderReservationSource={
 id:string;propertyId:string;status:string;source:string;checkIn:Date;checkOut:Date;adultCount:number;childCount:number;
};
export type ServiceOrderPropertySource={id:string;cityId:string|null;regionId:string|null};
/** The caller supplies native authorized reservation/property heads. These
 * dimensions never accept a client-supplied stay length or guest capacity. */
export function serviceOrderDimensions(raw:unknown,reservation:ServiceOrderReservationSource,property:ServiceOrderPropertySource){
 const request=serviceOrderRequestSchema.parse(raw),checkIn=reservation.checkIn.toISOString().slice(0,10),checkOut=reservation.checkOut.toISOString().slice(0,10);
 if(request.propertyId!==property.id||reservation.propertyId!==property.id||request.reservationId!==reservation.id)throw new ServiceOrderAccessError();
 if(["CANCELLED","NO_SHOW","CLOSED"].includes(reservation.status))throw new ServiceOrderSourceUnavailableError();
 if(request.serviceDate<checkIn||request.lastServiceDate>checkOut||request.guests>reservation.adultCount+reservation.childCount)throw new ServiceOrderValidationError();
 const days=(Date.parse(request.lastServiceDate+"T00:00:00Z")-Date.parse(request.serviceDate+"T00:00:00Z"))/86400000+1;
 if(!Number.isSafeInteger(days)||days<1)throw new ServiceOrderValidationError();
 return{quantity:request.quantity,guests:request.guests,days};
}

/** Existing public-field availability and exact catalog pricing are shared
 * with native authoring. CUSTOM always awaits an explicit reviewed quote. */
export function priceServiceOrder(raw:unknown,entry:ServiceCatalogEntry,reservation:ServiceOrderReservationSource,property:ServiceOrderPropertySource,rawPolicy:ServiceOrderPolicy){
 const request=serviceOrderRequestSchema.parse(raw),dimensions=serviceOrderDimensions(request,reservation,property),policy=serviceOrderPolicySchema.parse(rawPolicy);
 if(entry.key!==request.serviceKey||entry.available!==true||!entry.name||!entry.order_terms||!entry.currency)throw new ServiceOrderConfigurationError();
 if(dimensions.quantity>policy.max_quantity||dimensions.days>policy.max_service_days)throw new ServiceOrderValidationError();
 const fields={request:{...dimensions,date:request.serviceDate},reservation:{status:reservation.status,source:reservation.source,checkInDate:reservation.checkIn.toISOString().slice(0,10),checkOutDate:reservation.checkOut.toISOString().slice(0,10)},property};
 for(let index=0;index<dimensions.days;index++){
  fields.request.date=new Date(Date.parse(request.serviceDate+"T00:00:00Z")+index*86400000).toISOString().slice(0,10);
  if(!evaluate(entry.order_terms.availability,{fields,configs:{}}))throw new ServiceOrderSourceUnavailableError();
 }
 return{request,dimensions,price:serviceCatalogPrice(entry,dimensions)};
}

/** Confirmation is an explicit acceptance of the recorded total. A quote or
 * state change never asserts that funds were collected or work performed. */
export function validateServiceOrderTransition(input:{from:ServiceOrderState;to:ServiceOrderState;pricingModel:string;total:Money|null;quote?:z.infer<typeof serviceOrderQuoteSchema>;currency:string;currencyPrecision:number;hasActualTaskStart:boolean;hasActualTaskCompletion:boolean}){
 if(!canTransitionServiceOrder(input.from,input.to))throw new ServiceOrderConflictError();
 if(input.to==="QUOTED"){
  if(input.pricingModel!=="CUSTOM"||!input.quote||input.quote.currency!==input.currency)throw new ServiceOrderValidationError();
  const money=Money.of(input.quote.amount,input.quote.currency);
  if(input.currencyPrecision<0||input.currencyPrecision>2||money.amount.decimalPlaces()>input.currencyPrecision)throw new ServiceOrderValidationError();
  return money;
 }
 if(input.quote)throw new ServiceOrderValidationError();
 if(input.to==="CANCELLED"&&input.hasActualTaskCompletion)throw new ServiceOrderSourceUnavailableError();
 if(input.to==="CONFIRMED"&&(!input.total||input.pricingModel==="CUSTOM"&&input.from!=="QUOTED"))throw new ServiceOrderSourceUnavailableError();
 if(input.to==="IN_PROGRESS"&&!input.hasActualTaskStart||input.to==="FULFILLED"&&!input.hasActualTaskCompletion)throw new ServiceOrderSourceUnavailableError();
 return input.total;
}
