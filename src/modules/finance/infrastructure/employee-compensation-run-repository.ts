import { Prisma } from "@prisma/client";
import { employeeCompensationAuthorityLineFields,employeeCompensationContractWitnessFields } from "@/platform/authz/employee-compensation-resource";
import type { TenantTransaction } from "@/platform/db/tenant";

export const employeeCompensationRunLineFields = { ...employeeCompensationAuthorityLineFields,id: true,contractWitnesses:{orderBy:{sourceOn:"asc" as const},select:employeeCompensationContractWitnessFields},earningKind:true,earningPeriodKey:true,sourceCityId:true,sourceRegionId:true,sourceCity:{select:{id:true,regionId:true}},sourceRegion:{select:{id:true}}, taskId: true, personId: true, assignmentId: true, compensationId: true, configRuleId: true,
  completionEventId: true, propertyId: true, recordedCompletionAt: true, rate: true, amount: true, currency: true,
  property: { select: { cityId: true, regionId: true } } } as const;
const lineFields=employeeCompensationRunLineFields;
const include = { lines: { orderBy: { id: "asc" as const }, select: lineFields }, cancellation: true } satisfies Prisma.EmployeeCompensationRunInclude;
export type CompensationRunRecord = Prisma.EmployeeCompensationRunGetPayload<{ include: typeof include }>;
type PersistedDisplaySource=Awaited<ReturnType<EmployeeCompensationRunRepository["displayLines"]>>[number];
type MonthlyDisplayKeys="earningKind"|"earningPeriodKey"|"sourceCity"|"sourceRegion"|"contractWitnesses"|"amount"|"run";
export type CompensationDisplaySource=Omit<PersistedDisplaySource,MonthlyDisplayKeys|"compensation">&Partial<Pick<PersistedDisplaySource,MonthlyDisplayKeys>>&{compensation:Omit<PersistedDisplaySource["compensation"],"currency">&{currency?:string}};

export class EmployeeCompensationRunRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async lockKey(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":employee-compensation-run-key:" + key},0))::text`);
  }
  async lock(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":employee-compensation-run:" + id},0))::text`);
  }
  async find(id: string) { return this.tx.employeeCompensationRun.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  activeSubmissions(runId:string){return this.tx.employeeCompensationSubmission.count({where:{organizationId:this.organizationId,runId,withdrawal:null,OR:[{approval:null},{approval:{state:{not:"REJECTED"}}}]}});}
  byKey(idempotencyKey: string) { return this.tx.employeeCompensationRun.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include }); }
  create(input: Omit<Prisma.EmployeeCompensationRunUncheckedCreateInput, "organizationId" | "lines" | "cancellation">) {
    return this.tx.employeeCompensationRun.create({ data: { ...input, organizationId: this.organizationId } });
  }
  async createLines(runId: string, lines: ReadonlyArray<Omit<Prisma.EmployeeCompensationRunLineCreateManyInput, "organizationId" | "runId">>) {
    return this.tx.employeeCompensationRunLine.createMany({ data: lines.map(line => ({ ...line, organizationId: this.organizationId, runId })) });
  }
  cancel(runId: string, cancelledBy: string, reason: string) {
    return this.tx.employeeCompensationRunCancellation.create({ data: { organizationId: this.organizationId, runId, cancelledBy, reason } });
  }
  async window(fromOn: string, toOn: string, timezone: string) {
    const [row] = await this.tx.$queryRaw<Array<{ startsAt: Date; endsAt: Date }>>(Prisma.sql`SELECT
      (${fromOn}::date::timestamp AT TIME ZONE ${timezone}) AS "startsAt", ((${toOn}::date+1)::timestamp AT TIME ZONE ${timezone}) AS "endsAt"`);
    return row;
  }
  async calendarPoints(dates:readonly string[],timezone:string){return this.tx.$queryRaw<Array<{on:string;at:Date}>>(Prisma.sql`SELECT day::text AS "on",(day::timestamp AT TIME ZONE ${timezone}) AS at FROM unnest(ARRAY[${Prisma.join(dates)}]::date[]) day ORDER BY day`);}
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
  displayLines(runId: string, lineIds: readonly string[]) {
    return this.tx.employeeCompensationRunLine.findMany({ where: { organizationId: this.organizationId, runId, id: { in: [...lineIds] } },
      select: { id: true,amount:true,contractWitnesses:{orderBy:{sourceOn:"asc"},select:employeeCompensationContractWitnessFields},run:{select:{policySnapshot:true}},earningKind:true,earningPeriodKey:true,sourceCity:{select:{id:true,regionId:true}},sourceRegion:{select:{id:true}},taskId: true, personId: true, propertyId: true,
        person: { select: { displayName: true, userAccounts: { select: { id: true } } } },
        property: { select: { name: true, cityId: true, regionId: true } },
        compensation: { select: { currency:true,version: true, effectiveFrom: true, assignment: { select: { role: { select: { name: true } } } } } },
        task: { select: { state: true, assignedToPersonId: true, assignedToUserAccountId: true } },
        completionEvent: { select: { id: true, organizationId: true, taskId: true, version: true, actorId: true, after: true } } } });
  }
  async createContractWitnesses(rows:readonly Pick<Prisma.EmployeeCompensationContractWitnessCreateManyInput,"runLineId"|"sourceOn"|"occurredAt"|"eligible"|"compensationId"|"configRuleId">[]){
    if(!rows.length)return{count:0};
    const count=await this.tx.$executeRaw(Prisma.sql`INSERT INTO employee_compensation_contract_witness
      (organization_id,run_line_id,source_on,occurred_at,eligible,compensation_id,config_rule_id)
      SELECT ${this.organizationId}::uuid,x."runLineId",x."sourceOn",x."occurredAt",x.eligible,x."compensationId",x."configRuleId"
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x("runLineId" uuid,"sourceOn" date,"occurredAt" timestamptz,eligible boolean,"compensationId" uuid,"configRuleId" uuid)`);
    return{count};
  }
  sourceSnapshots(runId:string){return this.tx.employeeCompensationRunLine.findMany({where:{organizationId:this.organizationId,runId},select:{id:true,assignmentId:true,sourceSnapshot:true}});}
  people(ids: readonly string[]) {
    return this.tx.person.findMany({ where: { organizationId: this.organizationId, id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true, userAccounts: { select: { id: true } } } });
  }
  list(input: { after?: string; query: string; state: "all" | "draft" | "cancelled" }) {
    return this.tx.employeeCompensationRun.findMany({ where: { organizationId: this.organizationId,
      ...(input.after ? { id: { lt: input.after } } : {}),
      ...(input.query ? { purpose: { contains: input.query, mode: "insensitive" as const } } : {}),
      ...(input.state === "draft" ? { cancellation: null } : input.state === "cancelled" ? { cancellation: { isNot: null } } : {}) },
      orderBy: { id: "desc" }, take: 25, include });
  }
  async findMany(ids: readonly string[]) {
    return this.tx.employeeCompensationRun.findMany({ where: { organizationId: this.organizationId, id: { in: [...ids] } }, include });
  }
  claimSources(runId:string){
    return this.tx.employeeCompensationRunLine.findMany({where:{organizationId:this.organizationId,runId},orderBy:{id:"asc"},
      select:{...lineFields,property:{select:{id:true,timezone:true,cityId:true,regionId:true}},
        task:{select:{propertyId:true,reservationId:true,reservation:{select:{id:true,propertyId:true,status:true,createdBy:true}}}},
        completionEvent:{select:{id:true,organizationId:true,taskId:true,version:true,actorId:true,after:true}}}});
  }
}
