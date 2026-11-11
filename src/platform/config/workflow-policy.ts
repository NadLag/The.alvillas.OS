import {z} from "zod";
import {configSlugSchema} from "./identifiers";

export const workflowCatalogRuleKey="ops.workflows";
export const workflowCatalogMaximumItems=100;
const workflowConditionSchema:z.ZodType=z.lazy(()=>z.object({
 all:z.array(workflowConditionSchema).optional(),
 any:z.array(workflowConditionSchema).optional(),
 not:workflowConditionSchema.optional(),
 path:z.string().trim().min(1).max(160).optional(),
 op:z.enum(["=","!=",">",">=","<","<=","in","not_in","exists","between"]).optional(),
 value:z.unknown().optional()
}).refine(value=>Boolean(value.all?.length||value.any?.length||value.not||value.path&&value.op),"Workflow condition needs a combinator or path/operator"));

/** The existing canonical workflow catalog; native onboarding never owns a second definition. */
export const workflowCatalogSchema=z.object({workflows:z.array(z.object({
 key:configSlugSchema,
 version:z.number().int().min(1).optional(),
 trigger:z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
 conditions:workflowConditionSchema.optional(),
 actions:z.array(z.object({type:configSlugSchema}).passthrough()).min(1),
 idempotency_key:z.string().trim().min(1).max(180).optional()
}).passthrough()).max(workflowCatalogMaximumItems).refine(values=>new Set(values.map(row=>row.key)).size===values.length,"Workflow keys must be unique")}).passthrough();
