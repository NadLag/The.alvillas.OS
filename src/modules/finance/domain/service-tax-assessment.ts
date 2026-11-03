import {z} from "zod";
import {Money} from "@/platform/money/money";
import {taxRuleSchema} from "@/platform/config/rule-registry";
import {ServiceAllocationConfigurationError,type ServiceTaxAssessment} from "./service-allocation";

export type ServiceTaxPolicySource={id:string;key:string;version:number;value:unknown};
export type AssessedServiceTax=ServiceTaxAssessment&{policyRuleId:string;policyVersion:number;method:"FIXED"|"BASIS_POINTS";configuredValue:{amount:string}|{rateBps:number};basis:"ACTUAL_COLLECTED_GROSS";rounding:"HALF_UP_AT_LEDGER_PRECISION";gross:{amount:string;currency:string}};
/** The caller resolves an actual tenant policy at the source instant; this adapter applies only its explicit approved treatment. */
export function assessConfiguredServiceTaxes(gross:Money,keys:readonly string[],source:ServiceTaxPolicySource,minorUnit:number):AssessedServiceTax[]{
 function denied():never{throw new ServiceAllocationConfigurationError("An actual explicit service tax policy and supported currency precision are required");}
 if(!z.uuid().safeParse(source.id).success||source.key!=="finance.tax"||!Number.isSafeInteger(source.version)||source.version<1||!(gross instanceof Money)||!gross.amount.gt(0)||gross.amount.gt("9999999999999999.99")||!Number.isInteger(minorUnit)||minorUnit<0||minorUnit>2||gross.amount.decimalPlaces()>minorUnit||!keys.length||new Set(keys).size!==keys.length)denied();
 const config=taxRuleSchema.parse(source.value);return keys.map(ruleKey=>{const candidates=config.taxes.filter(tax=>tax.key===ruleKey);if(candidates.length!==1)denied();const tax=candidates[0],assessment=tax.service_assessment;if(!assessment||tax.currency!==gross.currency)denied();let amount:Money;
  if(assessment.method==="FIXED"){if(tax.amount===undefined)denied();amount=Money.of(tax.amount,gross.currency);}else{if(tax.rate_bps===undefined)denied();amount=gross.multiplyRatio(BigInt(tax.rate_bps),10000n);}
  if(amount.amount.decimalPlaces()>minorUnit)denied();return{ruleKey,amount,policyRuleId:source.id.toLowerCase(),policyVersion:source.version,method:assessment.method,configuredValue:assessment.method==="FIXED"?{amount:amount.toJSON().amount}:{rateBps:tax.rate_bps!},basis:assessment.basis,rounding:assessment.rounding,gross:gross.toJSON()};
 });
}
