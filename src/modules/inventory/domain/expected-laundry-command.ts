import {z} from "zod";
import {inventoryItemReasonSchema} from "./item-catalog";
const id=z.uuid().transform(value=>value.toLowerCase());
export const expectedLaundryInvoiceDraftSchema=z.object({batchId:id,quoteVersionId:id,pricingPropertyId:id.nullable(),priceAt:z.iso.datetime(),reason:inventoryItemReasonSchema}).strict();
export type ExpectedLaundryInvoiceDraft=z.infer<typeof expectedLaundryInvoiceDraftSchema>;
