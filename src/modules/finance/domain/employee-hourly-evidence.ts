import { Money } from "@/platform/money/money";
import { employeeHourlyEarnedAmount } from "./employee-hourly-earnings";
import { EmployeeCompensationRunAccessError } from "./employee-compensation-run";
type Amount={toString():string};
type Source={personId:string;currency:string;amount:Amount;recordedCompletionAt:Date;
 workTimeEvidence:{id:string;version:number;kind:string;performedByPersonId:string;policySnapshot:unknown;intervals:readonly {id:string;startsAt:Date;endsAt:Date}[]};
 workTimeDecision:{evidenceId:string;verdict:string;decidedAt:Date;decidedByPersonId:string};
 hourlyWitnesses:readonly {intervalId:string;startsAt:Date;endsAt:Date;compensation:{version:number;amount:Amount;currency:string}}[]};
const duration=(milliseconds:bigint)=>({hours:(milliseconds/3600000n).toString(),minutes:((milliseconds%3600000n)/60000n).toString(),seconds:((milliseconds%60000n)/1000n).toString()+(milliseconds%1000n?"."+(milliseconds%1000n).toString().padStart(3,"0").replace(/0+$/u,""):"")});
/** Render the retained real interval and contract foreign keys; a later policy never reprices history. */
export function employeeHourlySourceEvidence(source:Source){
 const evidence=source.workTimeEvidence,decision=source.workTimeDecision;
 if(evidence.kind!=="ACTUAL_INTERVALS"||evidence.performedByPersonId!==source.personId||decision.evidenceId!==evidence.id||decision.verdict!=="APPROVED"||!source.hourlyWitnesses.length)throw new EmployeeCompensationRunAccessError();
 const byInterval=new Map<string,Source["hourlyWitnesses"][number][]>();for(const witness of source.hourlyWitnesses){const retained=byInterval.get(witness.intervalId)??[];retained.push(witness);byInterval.set(witness.intervalId,retained);}
 const intervals=evidence.intervals.map(interval=>({...interval,performedByPersonId:evidence.performedByPersonId,validatedByPersonId:decision.decidedByPersonId,slices:(byInterval.get(interval.id)??[]).map(witness=>({startsAt:witness.startsAt,endsAt:witness.endsAt,rate:Money.of(witness.compensation.amount.toString(),witness.compensation.currency)}))}));
 if(intervals.reduce((count,interval)=>count+interval.slices.length,0)!==source.hourlyWitnesses.length)throw new EmployeeCompensationRunAccessError();
 const actual=employeeHourlyEarnedAmount(evidence.policySnapshot,source.currency,source.recordedCompletionAt,intervals);
 if(!actual.amount.equals(Money.of(source.amount.toString(),source.currency)))throw new EmployeeCompensationRunAccessError();
 return{evidenceVersion:evidence.version,validatedAt:decision.decidedAt.toISOString(),milliseconds:actual.milliseconds,duration:duration(BigInt(actual.milliseconds)),
  rates:source.hourlyWitnesses.map(witness=>({startsAt:witness.startsAt.toISOString(),endsAt:witness.endsAt.toISOString(),duration:duration(BigInt(witness.endsAt.getTime()-witness.startsAt.getTime())),contractVersion:witness.compensation.version,rate:Money.of(witness.compensation.amount.toString(),witness.compensation.currency).toJSON()}))};
}
