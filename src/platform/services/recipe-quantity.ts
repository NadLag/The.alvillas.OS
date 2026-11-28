import {chefMenuQuantitySchema} from "@/platform/config/chef-menu-policy";
/** Integer millionths preserve every declared recipe digit, including totals
 * beyond IEEE754 and decimal library precision. No unit conversion occurs. */
export function recipeQuantity(raw:string,units:bigint):bigint{const value=chefMenuQuantitySchema.parse(raw);if(units<1n)throw new RangeError("Positive original units required");const[whole,fraction=""]=value.split(".");return(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,"0")))*units;}
export function recipeQuantityString(value:bigint):string{const whole=value/1000000n,fraction=(value%1000000n).toString().padStart(6,"0").replace(/0+$/u,"");return whole.toString()+(fraction?"."+fraction:"");}
