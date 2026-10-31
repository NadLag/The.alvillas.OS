import type { TenantTransaction } from "@/platform/db/tenant";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
/** Call under the shared run-nonce lock; one intent spans every actual earning mode. */
export async function requireUnusedCompensationCreationIntent(tx:TenantTransaction,organizationId:string,key:string){if((await new EmployeeCompensationRunRepository(tx,organizationId).creationIntentsByKey(key)).length)throw new EmployeeCompensationRunConflictError();}
export async function requireCompensationCreationIntent(tx:TenantTransaction,organizationId:string,key:string,input:{actorId:string;earningKind:"PER_JOB"|"PER_MONTH"|"PER_HOUR";requestFingerprint:string;expectedSourceFingerprint?:string}){
 const intents=await new EmployeeCompensationRunRepository(tx,organizationId).creationIntentsByKey(key);if(!intents.length)return;const original=intents[0];
 if(intents.length!==1||original.outcomeId||!input.expectedSourceFingerprint||original.earningKind!==input.earningKind||original.requestedBy!==input.actorId||original.requestFingerprint!==input.requestFingerprint||original.reviewedSourceFingerprint!==input.expectedSourceFingerprint)throw new EmployeeCompensationRunConflictError();
}
