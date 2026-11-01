import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { employeeEarningRequestSourceFields } from "@/platform/authz/employee-earning-request-resource";
const include={outcome:true,sources:{orderBy:{id:"asc" as const},select:employeeEarningRequestSourceFields}} satisfies Prisma.EmployeeEarningRunRequestInclude;
export type EmployeeEarningRunRequestRecord=Prisma.EmployeeEarningRunRequestGetPayload<{include:typeof include}>;
export type EmployeeEarningRunOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export class EmployeeEarningRunRequestRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-earning-run-request-key:"+key},0))::text`);}
 async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-earning-run-request:"+id},0))::text`);}
 find(id:string){return this.tx.employeeEarningRunRequest.findFirst({where:{organizationId:this.organizationId,id},include});}
 byKey(idempotencyKey:string){return this.tx.employeeEarningRunRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include});}
 create(input:Omit<Prisma.EmployeeEarningRunRequestUncheckedCreateInput,"organizationId"|"sources"|"outcome">){return this.tx.employeeEarningRunRequest.create({data:{...input,organizationId:this.organizationId}});}
 createSources(requestId:string,rows:readonly Omit<Prisma.EmployeeEarningRequestWorkCreateManyInput,"organizationId"|"requestId">[]){return this.tx.employeeEarningRequestWork.createMany({data:rows.map(row=>({...row,organizationId:this.organizationId,requestId}))});}
 createWitnesses(rows:readonly Omit<Prisma.EmployeeEarningRequestHourlyWitnessCreateManyInput,"organizationId">[]){return this.tx.employeeEarningRequestHourlyWitness.createMany({data:rows.map(row=>({...row,organizationId:this.organizationId}))});}
 async createPercentageWitnesses(rows:readonly Omit<Prisma.EmployeeEarningRequestPercentageWitnessCreateManyInput,"organizationId">[]){
  if(!rows.length)return{count:0};
  const input=rows.map(row=>({...row,journalAmount:typeof row.journalAmount==="object"?row.journalAmount.toFixed():row.journalAmount}));
  const count=await this.tx.$executeRaw(Prisma.sql`INSERT INTO employee_earning_request_percentage_witness
   (id,organization_id,source_id,posting_id,compensation_id,config_rule_id,policy_rule_id,position,is_earning_base,journal_amount,
    property_id,source_city_id,source_region_id,reservation_id,task_id,owner_id,created_at)
   SELECT COALESCE(x.id,app_uuid_v7()),${this.organizationId}::uuid,x."sourceId",x."postingId",x."compensationId",x."configRuleId",x."policyRuleId",x.position,x."isEarningBase",x."journalAmount",
    x."propertyId",x."sourceCityId",x."sourceRegionId",x."reservationId",x."taskId",x."ownerId",COALESCE(x."createdAt",CURRENT_TIMESTAMP)
   FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS x(id uuid,"sourceId" uuid,"postingId" uuid,"compensationId" uuid,"configRuleId" uuid,"policyRuleId" uuid,
    position integer,"isEarningBase" boolean,"journalAmount" numeric,"propertyId" uuid,"sourceCityId" uuid,"sourceRegionId" uuid,"reservationId" uuid,"taskId" uuid,"ownerId" uuid,"createdAt" timestamptz)`);
  return{count};
 }
 outcome(input:Omit<Prisma.EmployeeEarningRunOutcomeUncheckedCreateInput,"organizationId">){return this.tx.employeeEarningRunOutcome.create({data:{...input,organizationId:this.organizationId}});}
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
