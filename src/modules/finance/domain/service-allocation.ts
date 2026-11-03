import {Money} from "@/platform/money/money";
import {serviceAllocationRecipeSchema,type ServiceAllocationRecipe} from "@/platform/config/service-allocation-policy";

export class ServiceAllocationConfigurationError extends Error{}
export class ServiceAllocationAccessError extends Error{}
export class ServiceAllocationSourceUnavailableError extends Error{}
export class ServiceAllocationSourceChangedError extends Error{}
export type ServiceAllocationPart={key:string;beneficiary:ServiceAllocationRecipe["components"][number]["beneficiary"];amount:Money;taxRuleKey:string|null};
/** An approved tax adapter supplies actual assessment; allocation never chooses a legal rate or treatment. */
export type ServiceTaxAssessment={ruleKey:string;amount:Money};
const maximum="9999999999999999.99";
function minorUnits(value:Money){return BigInt(value.toJSON().amount.replace(".",""));}
function fromMinorUnits(value:bigint,currency:string){const digits=value.toString().padStart(3,"0");return Money.of(digits.slice(0,-2)+"."+digits.slice(-2),currency);}

/** Fixed obligations are removed first; remaining proceeds are apportioned exactly under the explicit configured priority. */
export function allocateServiceProceeds(gross:Money,raw:unknown,taxes:readonly ServiceTaxAssessment[]):ServiceAllocationPart[]{
 const recipe=serviceAllocationRecipeSchema.parse(raw);if(!(gross instanceof Money)||gross.currency!==recipe.currency||!gross.amount.gt(0)||gross.amount.gt(maximum))throw new ServiceAllocationConfigurationError("Invalid original collected service amount");
 const fixed=recipe.components.filter(c=>c.mode==="FIXED"),fixedTotal=fixed.reduce((sum,c)=>sum.add(Money.of(c.amount,gross.currency)),Money.zero(gross.currency));
 if(fixedTotal.amount.gt(gross.amount))throw new ServiceAllocationConfigurationError("Configured obligations exceed original collected proceeds");
 const remaining=minorUnits(gross.subtract(fixedTotal)),weights=recipe.components.filter(c=>c.mode!=="FIXED"),assigned=weights.reduce((sum,c)=>sum+(c.mode==="BASIS_POINTS"?c.basis_points:0),0),priority=new Map(recipe.rounding_priority.map((key,index)=>[key,index]));
 const portions=weights.map(c=>{const weight=BigInt(c.mode==="BASIS_POINTS"?c.basis_points:10000-assigned),numerator=remaining*weight;return{key:c.key,units:numerator/10000n,fraction:numerator%10000n};});
 let residual=remaining-portions.reduce((sum,c)=>sum+c.units,0n);for(const c of [...portions].sort((a,b)=>a.fraction===b.fraction?priority.get(a.key)!-priority.get(b.key)!:a.fraction>b.fraction?-1:1)){if(residual===0n)break;c.units++;residual--;}
 if(residual!==0n)throw new ServiceAllocationConfigurationError("Configured apportionment does not conserve the original amount");
 const units=new Map(portions.map(c=>[c.key,c.units])),parts=recipe.components.map(c=>({key:c.key,beneficiary:c.beneficiary,amount:c.mode==="FIXED"?Money.of(c.amount,gross.currency):fromMinorUnits(units.get(c.key)!,gross.currency),taxRuleKey:c.tax_rule_key??null}));
 const expectedTaxes=new Map(recipe.tax_rule_keys.map(key=>[key,Money.zero(gross.currency)]));for(const part of parts)if(part.taxRuleKey)expectedTaxes.set(part.taxRuleKey,expectedTaxes.get(part.taxRuleKey)!.add(part.amount));
 if(new Set(taxes.map(t=>t.ruleKey)).size!==taxes.length||expectedTaxes.size!==taxes.length||taxes.some(t=>!(t.amount instanceof Money)||t.amount.currency!==gross.currency||!expectedTaxes.get(t.ruleKey)?.equals(t.amount)))throw new ServiceAllocationConfigurationError("Allocation must match each independently assessed tax policy exactly");
 if(!parts.reduce((sum,c)=>sum.add(c.amount),Money.zero(gross.currency)).equals(gross)||parts.some(c=>c.amount.amount.lt(0)))throw new ServiceAllocationConfigurationError("Allocated entitlement differs from original collected proceeds");return parts;
}
