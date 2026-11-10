import {z} from "zod";

export const serviceCatalogRuleKey="services.pricing";
// The existing canonical catalog protocol bounds one property catalog, independently of its configured business minimum.
export const serviceCatalogMaximumItems=200;
export const servicePricingModelSchema=z.enum(["FIXED","PER_GUEST","PER_DAY","CUSTOM"]);
