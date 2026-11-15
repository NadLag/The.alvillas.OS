import {z} from "zod";
import {ruleConditionSchema} from "@/platform/automation/rule";
import {configSlugSchema} from "./identifiers";
import {localizedTextSchema} from "@/i18n/content";

export const serviceCatalogRuleKey="services.pricing";
// The existing canonical catalog protocol bounds one property catalog, independently of its configured business minimum.
export const serviceCatalogMaximumItems=200;
export const servicePricingModelSchema=z.enum(["FIXED","PER_GUEST","PER_DAY","CUSTOM"]);
export const serviceCatalogAmountSchema=z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u,"Use a money amount with up to 2 decimals");
const currency=z.string().trim().regex(/^[A-Z]{3}$/u);

export const serviceCatalogCostSchema=z.object({
 amount:serviceCatalogAmountSchema,
 currency
}).strict();

export const serviceCatalogProviderSchema=z.object({
 component_key:configSlugSchema,
 kind:z.enum(["SUPPLIER","PERSON"]),
 id:z.uuid()
}).strict();
/** The canonical catalog references actual immutable financial policy versions.
 * It owns neither another allocation recipe nor a legal tax treatment. */
export const serviceCatalogOrderTermsSchema=z.object({
 schemaVersion:z.literal(1),
 approval_reference:z.string().trim().min(1).max(240),
 internal_cost:serviceCatalogCostSchema,
 providers:z.array(serviceCatalogProviderSchema).max(100).refine(rows=>new Set(rows.map(row=>row.component_key)).size===rows.length,"Provider component identities must be unique"),
 allocation_rule_id:z.uuid(),
 tax_rule_id:z.uuid(),
 availability:ruleConditionSchema
}).strict();

/** One canonical, browser-safe catalog protocol for configuration, onboarding,
 * staff authoring and reservation-bound service ordering. */
export const servicePricingSchema=z.object({services:z.array(z.object({
 key:configSlugSchema,
 name:localizedTextSchema.optional(),
 description:localizedTextSchema.optional(),
 available:z.boolean().optional(),
 pricing_model:servicePricingModelSchema,
 amount:serviceCatalogAmountSchema.optional(),
 currency:currency.optional(),
 order_terms:serviceCatalogOrderTermsSchema.optional()
}).passthrough()).max(serviceCatalogMaximumItems).refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"Service keys must be unique")}).passthrough();
