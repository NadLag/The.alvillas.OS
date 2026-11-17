import {z} from "zod";
import {servicePricingModelSchema} from "@/platform/config/service-catalog-policy";
export const serviceUnitsSchema=z.object({quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),guests:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),days:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
/** One exact multiplier for original prices and operational recipe needs. */
export function servicePricedUnits(model:unknown,dimensions:unknown):bigint{
 const pricing=servicePricingModelSchema.parse(model),units=serviceUnitsSchema.parse(dimensions);
 return BigInt(units.quantity)*(pricing==="PER_GUEST"?BigInt(units.guests):pricing==="PER_DAY"?BigInt(units.days):1n);
}
