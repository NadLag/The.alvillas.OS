import {z} from "zod";
import {Money} from "@/platform/money/money";
import {configSlugSchema} from "./identifiers";
export const laundryPricingPolicyKey="operations.laundry_pricing";
const supplierPrefix=laundryPricingPolicyKey+".supplier.",amount=z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u),currency=z.string().trim().regex(/^[A-Z]{3}$/u);
/** Existing global definitions remain readable in their original shape. They
 * never silently become a named supplier's agreed price list. */
export const legacyLaundryPricingSchema=z.object({prices:z.array(z.object({item:configSlugSchema,amount,currency}).passthrough())}).passthrough();
export const laundrySupplierPriceMaximumLines=500;
export const laundryInvoiceQuantityBasisSchema=z.enum(["PLANNED","SENT","RECEIVED","WASHED"]);
export const laundryInvoiceBillingSchema=z.object({quantityBasis:laundryInvoiceQuantityBasisSchema,billableConditions:z.array(z.enum(["USABLE","DAMAGED"])).min(1).max(2)}).strict().superRefine((value,context)=>{if(new Set(value.billableConditions).size!==value.billableConditions.length)context.addIssue({code:"custom",path:["billableConditions"],message:"Each original physical condition appears once"});});
export const laundrySupplierPricePolicySchema=z.object({currency,prices:z.array(z.object({item:configSlugSchema,unit:z.string().trim().min(1).max(60),amount}).strict()).min(1).max(laundrySupplierPriceMaximumLines),billing:laundryInvoiceBillingSchema.optional()}).strict().superRefine((value,context)=>{if(new Set(value.prices.map(row=>row.item)).size!==value.prices.length)context.addIssue({code:"custom",path:["prices"],message:"Each original SKU appears once in a supplier price list"});}).transform(value=>({...value,prices:value.prices.map(row=>({...row,amount:Money.of(row.amount,value.currency).toJSON().amount}))}));
export function laundrySupplierPricePolicyKey(supplierId:string){return supplierPrefix+z.uuid().parse(supplierId).toLowerCase();}
export function laundryPricingSupplierId(key:string){if(!key.startsWith(supplierPrefix))return null;const parsed=z.uuid().safeParse(key.slice(supplierPrefix.length));return parsed.success&&parsed.data===parsed.data.toLowerCase()?parsed.data:null;}
export const protectedLaundryPricingKey=(key:string)=>key===laundryPricingPolicyKey||key.startsWith(supplierPrefix);
export type LaundrySupplierPricePolicy=z.infer<typeof laundrySupplierPricePolicySchema>;
