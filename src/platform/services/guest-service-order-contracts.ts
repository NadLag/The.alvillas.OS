import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {serviceCatalogAmountSchema,servicePricingModelSchema} from "@/platform/config/service-catalog-policy";
import {serviceOrderRequestSchema,serviceOrderStateSchema} from "@/modules/services/domain/service-order-contracts";
import type {ServiceCatalogItem} from "@/modules/services/domain/service-catalog-view";

const fields=serviceOrderRequestSchema.shape,currency=z.string().regex(/^[A-Z]{3}$/u),identity=z.uuid();
export const guestServiceOrderSelectionSchema=z.object({serviceKey:fields.serviceKey,serviceDate:fields.serviceDate,lastServiceDate:fields.lastServiceDate,quantity:fields.quantity,guests:fields.guests}).strict();
export const guestServiceOfferSchema=z.object({key:configSlugSchema,name:localizedTextSchema,description:localizedTextSchema.nullable(),pricingModel:servicePricingModelSchema,unitAmount:serviceCatalogAmountSchema.nullable(),currency,quoteRequired:z.boolean()}).strict().refine(offer=>offer.quoteRequired===(offer.pricingModel==="CUSTOM")&&(offer.unitAmount===null)===offer.quoteRequired);
export const guestServiceOfferPageSchema=z.object({items:z.array(guestServiceOfferSchema).max(20),next:configSlugSchema.nullable()}).strict();
export const guestServiceOrderReviewTokenSchema=z.string().min(1).max(32768);
export const guestServiceOrderDraftSchema=guestServiceOrderSelectionSchema.extend({idempotencyKey:identity,locale:z.enum(["en","fr","ar"])}).strict();
export const guestServiceOrderSubmitSchema=guestServiceOrderDraftSchema.extend({reviewFingerprint:guestServiceOrderReviewTokenSchema}).strict();
export const guestServiceOrderRecoverySchema=z.object({idempotencyKey:identity}).strict();
export const guestServiceOrderPublicReviewSchema=z.object({selection:guestServiceOrderSelectionSchema,title:localizedTextSchema,totalAmount:serviceCatalogAmountSchema.nullable(),currency,quoteRequired:z.boolean(),reviewFingerprint:guestServiceOrderReviewTokenSchema}).strict().refine(value=>(value.totalAmount===null)===value.quoteRequired);
export const guestServiceOrderReceiptSchema=z.object({id:identity,orderId:identity,idempotencyKey:identity,state:serviceOrderStateSchema,version:z.number().int().positive(),totalAmount:serviceCatalogAmountSchema.nullable(),currency,createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export const guestServiceOrderRecoveryResponseSchema=z.discriminatedUnion("recorded",[guestServiceOrderReceiptSchema.extend({recorded:z.literal(true)}),z.object({recorded:z.literal(false),idempotencyKey:identity}).strict()]);
export class GuestServiceOfferUnavailableError extends Error{constructor(){super("guest_service_offer_unavailable");}}

/** Serialize only an already authorized, explicitly released canonical offer. */
export function projectReleasedGuestServiceOffer(item:ServiceCatalogItem){
 if(!item.available||!item.orderTerms)throw new GuestServiceOfferUnavailableError();
 const publicOffer=guestServiceOfferSchema.safeParse({key:item.key,name:item.name,description:item.description,pricingModel:item.pricingModel,unitAmount:item.amount,currency:item.currency,quoteRequired:item.pricingModel==="CUSTOM"});if(!publicOffer.success)throw new GuestServiceOfferUnavailableError();return publicOffer.data;
}
/** Reservation/property identity comes from the verified server-side source. */
export function bindGuestServiceOrderSelection(raw:unknown,source:{propertyId:string;reservationId:string},guestRequestId:string){
 const selected=guestServiceOrderSelectionSchema.parse(raw),requestId=identity.parse(guestRequestId);return serviceOrderRequestSchema.parse({...selected,propertyId:source.propertyId,reservationId:source.reservationId,reason:"Guest Hub service selection "+requestId});
}
