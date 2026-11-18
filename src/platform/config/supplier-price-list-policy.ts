import { z } from "zod";

const prefix = "finance.supplier_price_list.";
export const supplierPriceListKey = (supplierId: string) => prefix + supplierId;
export function supplierPriceListSupplierId(key: string) {
  const id = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return id === id.toLowerCase() && z.uuid().safeParse(id).success ? id : null;
}
export const supplierPriceListPolicySchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  items: z.array(z.strictObject({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u),
    name: z.string().trim().min(1).max(160),
    unit: z.string().trim().min(1).max(80),
    amount: z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/u)
  })).min(1).max(100).refine(items => new Set(items.map(item => item.code)).size === items.length)
});
