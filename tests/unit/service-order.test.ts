import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {Money} from "@/platform/money/money";
import {canTransitionServiceOrder,priceServiceOrder,serviceOrderDimensions,serviceOrderTransitionSchema,validateServiceOrderTransition,ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderSourceUnavailableError,ServiceOrderValidationError} from "@/modules/services/domain/service-order";
import type {ServiceCatalogEntry} from "@/modules/services/domain/service-catalog";
import type {ServiceOrderPolicy} from "@/platform/config/service-order-policy";

const property={id:randomUUID(),cityId:null,regionId:null},reservation={id:randomUUID(),propertyId:property.id,status:"CONFIRMED",source:"DIRECT",checkIn:new Date("2026-05-01T00:00:00Z"),checkOut:new Date("2026-05-05T00:00:00Z"),adultCount:2,childCount:1},request={propertyId:property.id,reservationId:reservation.id,serviceKey:"reviewed_service",serviceDate:"2026-05-02",lastServiceDate:"2026-05-04",quantity:3,guests:3,reason:"Actual reviewed guest request"};
const entry:ServiceCatalogEntry={key:request.serviceKey,name:{en:"Reviewed service",fr:"Service validé"},available:true,pricing_model:"PER_GUEST",amount:"0.10",currency:"MAD",order_terms:{schemaVersion:1,approval_reference:"Actual configured approval",internal_cost:{amount:"0.00",currency:"MAD"},providers:[],allocation_rule_id:randomUUID(),tax_rule_id:randomUUID(),availability:{all:[{path:"request.guests",op:"<=",value:3},{path:"reservation.source",op:"=",value:"DIRECT"}]}}};
const transition={from:"REQUESTED"as const,to:"CONFIRMED"as const,pricingModel:"FIXED",total:Money.of("0.90","MAD"),currency:"MAD",currencyPrecision:2,hasActualTaskStart:false,hasActualTaskCompletion:false};
const policy:ServiceOrderPolicy={schemaVersion:1,max_quantity:10,max_service_days:5,participant_basis:"SELECTED_RESERVATION_GUESTS",date_basis:"INCLUSIVE_RESERVATION_DATES"};

describe("native service order consent and lifecycle",()=>{
 it("derives integer service days and capacity from the selected native reservation",()=>{
  expect(serviceOrderDimensions(request,reservation,property)).toEqual({quantity:3,guests:3,days:3});
  expect(()=>serviceOrderDimensions({...request,guests:4},reservation,property)).toThrow(ServiceOrderValidationError);
  expect(()=>serviceOrderDimensions({...request,lastServiceDate:"2026-05-06"},reservation,property)).toThrow(ServiceOrderValidationError);
  expect(()=>serviceOrderDimensions(request,{...reservation,propertyId:randomUUID()},property)).toThrow(ServiceOrderAccessError);
  expect(()=>serviceOrderDimensions(request,{...reservation,status:"CANCELLED"},property)).toThrow(ServiceOrderSourceUnavailableError);
 });
 it("evaluates configured public availability and computes exact selling totals",()=>{
  const result=priceServiceOrder(request,entry,reservation,property,policy);
  expect(result.price.kind).toBe("PRICED");if(result.price.kind!=="PRICED")throw Error("Expected original configured price");
  expect(result.price.amount.toJSON()).toEqual({amount:"0.90",currency:"MAD"});
  expect(()=>priceServiceOrder(request,entry,{...reservation,source:"AIRBNB"},property,policy)).toThrow(ServiceOrderSourceUnavailableError);
  expect(()=>priceServiceOrder(request,entry,reservation,property,{...policy,max_quantity:2})).toThrow(ServiceOrderValidationError);
  expect(()=>priceServiceOrder(request,entry,reservation,property,{...policy,max_service_days:2})).toThrow(ServiceOrderValidationError);
  expect(()=>priceServiceOrder(request,{...entry,order_terms:{...entry.order_terms!,availability:{path:"request.date",op:"!=",value:"2026-05-03"}}},reservation,property,policy)).toThrow(ServiceOrderSourceUnavailableError);
 });
 it("retains CUSTOM as a real quote requirement and requires explicit accepted quote state",()=>{
  expect(priceServiceOrder(request,{...entry,pricing_model:"CUSTOM"},reservation,property,policy).price.kind).toBe("QUOTE_REQUIRED");
  expect(()=>validateServiceOrderTransition({...transition,pricingModel:"CUSTOM",total:null})).toThrow(ServiceOrderSourceUnavailableError);
  expect(()=>validateServiceOrderTransition({...transition,pricingModel:"CUSTOM"})).toThrow(ServiceOrderSourceUnavailableError);
  expect(validateServiceOrderTransition({...transition,from:"QUOTED",pricingModel:"CUSTOM"})).toEqual(transition.total);
 });
 it("never turns a client state change into actual started or fulfilled work",()=>{
  expect(()=>validateServiceOrderTransition({...transition,from:"CONFIRMED",to:"IN_PROGRESS"})).toThrow(ServiceOrderSourceUnavailableError);
  expect(()=>validateServiceOrderTransition({...transition,from:"IN_PROGRESS",to:"FULFILLED"})).toThrow(ServiceOrderSourceUnavailableError);
  expect(validateServiceOrderTransition({...transition,from:"IN_PROGRESS",to:"FULFILLED",hasActualTaskCompletion:true})).toEqual(transition.total);
  expect(validateServiceOrderTransition({...transition,from:"CONFIRMED",to:"FULFILLED",hasActualTaskCompletion:true})).toEqual(transition.total);
  expect(()=>validateServiceOrderTransition({...transition,from:"IN_PROGRESS",to:"CANCELLED",hasActualTaskCompletion:true})).toThrow(ServiceOrderSourceUnavailableError);
  for(const state of["FULFILLED","CANCELLED","REJECTED"]as const)expect(canTransitionServiceOrder(state,"CONFIRMED")).toBe(false);
  expect(()=>validateServiceOrderTransition({...transition,from:"FULFILLED"})).toThrow(ServiceOrderConflictError);
 });
 it("keeps explicit quotes in the registered currency precision without rounding",()=>{
  const quote={amount:"12.34",currency:"MAD",approvalReference:"Actual reviewed quote"};
  expect(validateServiceOrderTransition({...transition,to:"QUOTED",pricingModel:"CUSTOM",quote})).toEqual(Money.of("12.34","MAD"));
  expect(()=>validateServiceOrderTransition({...transition,to:"QUOTED",pricingModel:"CUSTOM",quote,currencyPrecision:0})).toThrow(ServiceOrderValidationError);
  expect(()=>validateServiceOrderTransition({...transition,to:"QUOTED",quote})).toThrow(ServiceOrderValidationError);
 });
 it("binds quote-bearing commands only to an explicit quote transition",()=>{
  const command={orderId:randomUUID(),expectedVersion:1,state:"QUOTED",quote:{amount:"12.00",currency:"MAD",approvalReference:"Actual quote"},reason:request.reason,reviewFingerprint:"a".repeat(64),idempotencyKey:randomUUID()};
  expect(serviceOrderTransitionSchema.safeParse(command).success).toBe(true);
  expect(serviceOrderTransitionSchema.safeParse({...command,state:"CONFIRMED"}).success).toBe(false);
  expect(serviceOrderTransitionSchema.safeParse({...command,quote:undefined}).success).toBe(false);
  expect(serviceOrderTransitionSchema.safeParse({...command,state:"CONFIRMED",quote:undefined,taskPlan:{type:"TRANSFER",priority:"NORMAL",checklistTemplateKey:"owned_service"}}).success).toBe(true);
 });
});
