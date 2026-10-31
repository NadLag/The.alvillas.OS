import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

/** Read actual approved work and original contract boundaries in bounded query groups. */
export class EmployeeHourlyRunSourceRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async evidence(ids:readonly string[]){
  type Row={id:string;taskId:string;version:number;kind:string;performedByPersonId:string;completionEventId:string;policyRuleId:string;sourceSnapshot:Prisma.JsonValue;policySnapshot:Prisma.JsonValue;
   policyRule:{id:string;key:string;scopeType:string;scopeId:string|null;value:Prisma.JsonValue;version:number};decision:{id:string;decidedByPersonId:string;verdict:string}|null;intervals:Array<{id:string;startsAt:string;endsAt:string}>};
  if(!ids.length)return[];
  const rows=await this.tx.$queryRaw<Row[]>(Prisma.sql`SELECT e.id,e.task_id AS "taskId",e.version,e.kind,e.performed_by_person_id AS "performedByPersonId",e.completion_event_id AS "completionEventId",e.policy_rule_id AS "policyRuleId",e.source_snapshot AS "sourceSnapshot",e.policy_snapshot AS "policySnapshot",
   jsonb_build_object('id',p.id,'key',p.key,'scopeType',p.scope_type,'scopeId',p.scope_id,'value',p.value,'version',p.version) AS "policyRule",
   CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'decidedByPersonId',d.decided_by_person_id,'verdict',d.verdict) END AS decision,
   coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'startsAt',i.starts_at,'endsAt',i.ends_at) ORDER BY i.position) FROM employee_work_time_interval i WHERE i.organization_id=e.organization_id AND i.evidence_id=e.id),'[]'::jsonb) AS intervals
   FROM employee_work_time_evidence e JOIN config_rule p ON p.organization_id=e.organization_id AND p.id=e.policy_rule_id
   LEFT JOIN employee_work_time_decision d ON d.organization_id=e.organization_id AND d.evidence_id=e.id
   WHERE e.organization_id=${this.organizationId}::uuid AND e.id IN(${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))})`);
  return rows.map(row=>({...row,intervals:row.intervals.map(interval=>({...interval,startsAt:new Date(interval.startsAt),endsAt:new Date(interval.endsAt)}))}));
 }
 latest(taskIds:readonly string[]){return this.tx.employeeWorkTimeEvidence.findMany({where:{organizationId:this.organizationId,taskId:{in:[...new Set(taskIds)]}},distinct:["taskId"],orderBy:[{taskId:"asc"},{version:"desc"}],select:{id:true,taskId:true,performedByPersonId:true,version:true,kind:true}});}
 async rateBoundaries(assignmentIds:readonly string[],startsAt:Date,endsAt:Date){
  if(!assignmentIds.length)return[];
  const ids=Prisma.join([...new Set(assignmentIds)].map(id=>Prisma.sql`${id}::uuid`));
  return this.tx.$queryRaw<Array<{assignmentId:string;effectiveFrom:Date;precise:boolean}>>(Prisma.sql`WITH points AS(
   SELECT assignment_id,effective_from FROM team_compensation WHERE organization_id=${this.organizationId}::uuid AND assignment_id IN(${ids})
   UNION ALL SELECT scope_id,effective_from FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND key='staff.compensation' AND scope_type='role_assignment' AND scope_id IN(${ids}) AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED')
   UNION ALL SELECT scope_id,effective_to FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND key='staff.compensation' AND scope_type='role_assignment' AND scope_id IN(${ids}) AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_to IS NOT NULL)
   SELECT DISTINCT assignment_id AS "assignmentId",effective_from AS "effectiveFrom",date_trunc('milliseconds',effective_from)=effective_from AS precise FROM points
   WHERE effective_from>${startsAt} AND effective_from<${endsAt} ORDER BY assignment_id,effective_from`);
 }
}
