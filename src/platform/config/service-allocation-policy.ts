import {z} from "zod";
import {configSlugSchema} from "./identifiers";

export const serviceAllocationPolicyKey="finance.service_allocation";
const amount=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u);
const common={key:configSlugSchema,beneficiary:z.enum(["OWNER","COMPANY","SUPPLIER","PERSON","TAX"]),tax_rule_key:configSlugSchema.optional()};
export const serviceAllocationComponentSchema=z.discriminatedUnion("mode",[
 z.object({...common,mode:z.literal("FIXED"),amount}).strict(),
 z.object({...common,mode:z.literal("BASIS_POINTS"),basis_points:z.number().int().min(0).max(10000)}).strict(),
 z.object({...common,mode:z.literal("REMAINDER")}).strict()
]);
export const serviceAllocationRecipeSchema=z.object({
 service_key:configSlugSchema,currency:z.string().regex(/^[A-Z]{3}$/u),
 basis:z.literal("COLLECTED_GROSS_LESS_FIXED_COMPONENTS"),rounding:z.literal("LARGEST_REMAINDER"),
 provider_treatment:z.literal("REVENUE_WITH_EXISTING_COMPANY_COST"),
 components:z.array(serviceAllocationComponentSchema).min(1).max(100),rounding_priority:z.array(configSlugSchema).min(1).max(100),
 tax_rule_keys:z.array(configSlugSchema).min(1).max(20)
}).strict().superRefine((recipe,ctx)=>{
 const keys=recipe.components.map(c=>c.key),variable=recipe.components.filter(c=>c.mode!=="FIXED").map(c=>c.key),priorities=new Set(recipe.rounding_priority);
 if(new Set(keys).size!==keys.length)ctx.addIssue({code:"custom",message:"Allocation component keys must be unique"});
 if(recipe.components.filter(c=>c.mode==="REMAINDER").length!==1)ctx.addIssue({code:"custom",message:"Exactly one explicitly configured remainder component is required"});
 if(recipe.components.reduce((total,c)=>total+(c.mode==="BASIS_POINTS"?c.basis_points:0),0)>10000)ctx.addIssue({code:"custom",message:"Configured proportions cannot exceed the available amount"});
 if(priorities.size!==recipe.rounding_priority.length||priorities.size!==variable.length||variable.some(key=>!priorities.has(key)))ctx.addIssue({code:"custom",message:"Rounding priority must name every variable component exactly once"});
 if(recipe.components.some(c=>(c.beneficiary==="TAX")!==Boolean(c.tax_rule_key)))ctx.addIssue({code:"custom",message:"Tax components require an explicit tax policy; other components cannot impersonate tax"});
 if(new Set(recipe.tax_rule_keys).size!==recipe.tax_rule_keys.length||recipe.components.some(c=>c.tax_rule_key&&!recipe.tax_rule_keys.includes(c.tax_rule_key)))ctx.addIssue({code:"custom",message:"Every tax allocation must bind a separately assessed configured policy"});
});
export const serviceAllocationPolicySchema=z.object({source:z.literal("COMPLETED_SERVICE_COLLECTION"),rule_selection:z.literal("AT_ACTUAL_SERVICE_COMPLETION"),ownership_basis:z.enum(["RESERVATION_SNAPSHOT","CURRENT_PROPERTY_OWNERS_AT_ADMISSION"]),services:z.array(serviceAllocationRecipeSchema).min(1).max(200)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.services.map(s=>s.service_key)).size!==value.services.length)ctx.addIssue({code:"custom",message:"Service allocation identities must be unique"});
});
export type ServiceAllocationRecipe=z.infer<typeof serviceAllocationRecipeSchema>;
