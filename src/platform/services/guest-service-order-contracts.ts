import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {serviceCatalogAmountSchema,servicePricingModelSchema} from "@/platform/config/service-catalog-policy";
import {chefMenuTextSchema} from "@/platform/config/chef-menu-policy";
import {serviceOrderRequestSchema,serviceOrderStateSchema} from "@/modules/services/domain/service-order-contracts";
import type {ServiceCatalogItem} from "@/modules/services/domain/service-catalog-view";
import {guestHubRenderedFormNoticeSchema} from "@/modules/guest-hub/domain/guest-hub-form-policy";
import {guestHubServiceCategorySchema,type GuestHubServiceCategory} from "@/modules/guest-hub/domain/guest-hub-service-order-policy";

const fields=serviceOrderRequestSchema.shape,currency=z.string().regex(/^[A-Z]{3}$/u),identity=z.uuid();
export const guestChefMenuSchema = z.object({
  servingsPerUnit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ingredients: z.array(chefMenuTextSchema).min(1).max(100),
  allergens: z.array(chefMenuTextSchema).max(50)
}).strict();
export type GuestChefMenu = z.infer<typeof guestChefMenuSchema>;
export const guestServiceOrderSelectionSchema=z.object({serviceKey:fields.serviceKey,serviceDate:fields.serviceDate,lastServiceDate:fields.lastServiceDate,quantity:fields.quantity,guests:fields.guests,groceryItems:fields.groceryItems,transfer:fields.transfer}).strict();
export const guestServiceOfferSchema=z.object({key:configSlugSchema,name:localizedTextSchema,description:localizedTextSchema.nullable(),pricingModel:servicePricingModelSchema,unitAmount:serviceCatalogAmountSchema.nullable(),currency,quoteRequired:z.boolean(),chefMenu:guestChefMenuSchema.optional(),grocery:z.literal(true).optional(),transfer:z.literal(true).optional(),category:guestHubServiceCategorySchema.optional()}).strict().refine(offer=>offer.quoteRequired===(offer.pricingModel==="CUSTOM")&&(offer.unitAmount===null)===offer.quoteRequired);
export const guestServiceOfferPageSchema=z.object({items:z.array(guestServiceOfferSchema).max(20),next:configSlugSchema.nullable()}).strict();
export const guestServiceOrderReviewTokenSchema=z.string().min(40).max(512).regex(/^guest-service-order-review-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestServiceOrderDraftSchema=guestServiceOrderSelectionSchema.extend({idempotencyKey:identity,locale:z.enum(["en","fr","ar"])}).strict();
export const guestServiceOrderSubmitSchema=guestServiceOrderDraftSchema.extend({acknowledged:z.literal(true),reviewFingerprint:guestServiceOrderReviewTokenSchema}).strict();
export const guestServiceOrderRecoverySchema=z.object({idempotencyKey:identity}).strict();
export const guestServiceOrderPublicReviewSchema=z.object({selection:guestServiceOrderSelectionSchema,title:localizedTextSchema,totalAmount:serviceCatalogAmountSchema.nullable(),currency,quoteRequired:z.boolean(),chefMenu:guestChefMenuSchema.optional(),category:guestHubServiceCategorySchema.optional(),notice:guestHubRenderedFormNoticeSchema,reviewFingerprint:guestServiceOrderReviewTokenSchema}).strict().refine(value=>(value.totalAmount===null)===value.quoteRequired);
export const guestServiceOrderReceiptSchema=z.object({id:identity,orderId:identity,idempotencyKey:identity,state:serviceOrderStateSchema,version:z.number().int().positive(),totalAmount:serviceCatalogAmountSchema.nullable(),currency,createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export const guestServiceOrderRecoveryResponseSchema=z.discriminatedUnion("recorded",[guestServiceOrderReceiptSchema.extend({recorded:z.literal(true)}),z.object({recorded:z.literal(false),idempotencyKey:identity}).strict()]);
export class GuestServiceOfferUnavailableError extends Error{constructor(){super("guest_service_offer_unavailable");}}

/** Serialize only an already authorized, explicitly released canonical offer. */
export function projectReleasedGuestServiceOffer(item:Pick<ServiceCatalogItem,"key"|"name"|"description"|"pricingModel"|"amount"|"currency"|"available"|"orderTerms">, category?: GuestHubServiceCategory){
 if(!item.available||!item.orderTerms)throw new GuestServiceOfferUnavailableError();
 const menu = item.orderTerms.chef_menu;
 const chefMenu = menu && { servingsPerUnit: menu.serving_quantity, ingredients: menu.ingredients.map(ingredient => ingredient.name),
   allergens: menu.allergens.map(allergen => allergen.name) };
 const publicOffer=guestServiceOfferSchema.safeParse({key:item.key,name:item.name,description:item.description,pricingModel:item.pricingModel,unitAmount:item.amount,currency:item.currency,quoteRequired:item.pricingModel==="CUSTOM",...chefMenu && { chefMenu },
   ...(item.orderTerms.grocery_order ? { grocery: true } : {}), ...(item.orderTerms.transfer_order ? { transfer: true } : {}),
   ...(category ? { category } : {})});
 if(!publicOffer.success)throw new GuestServiceOfferUnavailableError();
 return publicOffer.data;
}
/** Reservation/property identity comes from the verified server-side source. */
export function bindGuestServiceOrderSelection(raw:unknown,source:{propertyId:string;reservationId:string},guestRequestId:string){
 const selected=guestServiceOrderSelectionSchema.parse(raw),requestId=identity.parse(guestRequestId);return serviceOrderRequestSchema.parse({...selected,propertyId:source.propertyId,reservationId:source.reservationId,reason:"Guest Hub service selection "+requestId});
}
