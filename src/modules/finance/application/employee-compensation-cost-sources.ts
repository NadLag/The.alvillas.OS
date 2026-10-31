import type { TenantTransaction } from "@/platform/db/tenant";
import { calendarDateStart } from "@/platform/time/calendar";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { employeeCompensationSourceIdentity } from "../domain/employee-compensation-source-identity";
import { EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { CompanyLedgerRepository } from "../infrastructure/company-ledger-repository";
import type { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
type Source=Awaited<ReturnType<EmployeeCompensationRunRepository["claimSources"]>>[number];
/** Every private cost reader uses the same actual earning source, calendar and independent company boundary. */
export async function employeeCompensationCostSources(organizationId:string,createdBy:string,sources:readonly Source[],tx:TenantTransaction,costOn?:string){
 const companyTimezone=sources.some(source=>!source.propertyId)?(await new CompanyLedgerRepository(tx,organizationId).settings()).timezone:null,starts=new Map<string,Date>();
 return sources.map(source=>{
  const identity=employeeCompensationSourceIdentity(source),reservationId=source.task?.reservationId??null,timezone=source.property?.timezone??companyTimezone;
  if(!timezone||source.propertyId&&!source.property||(identity.kind==="PER_JOB"||identity.kind==="PER_HOUR")&&(!source.task||!source.completionEvent)||!source.propertyId&&reservationId)throw new EmployeeCompensationClaimSourceError();
  let at=source.recordedCompletionAt;if(costOn){at=starts.get(timezone)??calendarDateStart(costOn,timezone);starts.set(timezone,at);}
  return{source,identity,reservationId,timezone,at,organizationOnly:!source.propertyId,...employeeCompensationFinancialSourceFacts(organizationId,createdBy,{...source,reservationId},at)};
 });
}
