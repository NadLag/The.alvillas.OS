import {z} from "zod";
import {supplierPriceVersionViewSchema} from "./supplier-price-view";
import {laundryPriceChangeEvidenceSchema} from "./laundry-price-change";
const money=z.object({amount:z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
export const laundryPriceChangeContextSchema=z.object({associationId:z.uuid(),basis:supplierPriceVersionViewSchema,affected:z.array(z.string()).max(100),evidence:laundryPriceChangeEvidenceSchema,expected:money,actual:money,state:z.enum(["POSSIBLE_CHANGE","MATCHED","CURRENCY_MISMATCH"]),receipt:z.object({documentId:z.uuid(),version:z.number().int().positive(),title:z.string()}).strict(),invoice:z.object({id:z.uuid(),number:z.string()}).strict(),retainedPrices:z.array(z.object({item:z.string(),unit:z.string(),price:z.string().nullable()}).strict()).max(100)}).strict();
export type LaundryPriceChangeContext=z.infer<typeof laundryPriceChangeContextSchema>;
