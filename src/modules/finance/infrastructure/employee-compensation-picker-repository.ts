import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { CompensationDisplaySource } from "./employee-compensation-run-repository";

/** Actual completed tasks and canonical role assignments; this repository owns no rates or balances. */
export class EmployeeCompensationPickerRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  monthlyAssignments(input:{startsAt:Date;endsAt:Date;currency:string;after?:string}){
    return this.tx.roleAssignment.findMany({where:{organizationId:this.organizationId,...input.after?{id:{gt:input.after}}:{},validFrom:{lt:input.endsAt},OR:[{validTo:null},{validTo:{gt:input.startsAt}}],teamCompensations:{some:{organizationId:this.organizationId,mode:"PER_MONTH",currency:input.currency,effectiveFrom:{lt:input.endsAt}}}},orderBy:{id:"asc"},take:26,select:{id:true}});
  }
  async monthlyDisplay(entries:readonly {assignmentId:string;personId:string;propertyId:string|null;compensationId:string;taskId:string|null;sourceCityId:string|null;sourceRegionId:string|null}[]):Promise<CompensationDisplaySource[]>{
    const [people,properties,tasks,contracts]=await Promise.all([
      this.tx.person.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.personId))]}},select:{id:true,displayName:true,userAccounts:{select:{id:true}}}}),
      this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:entries.flatMap(row=>row.propertyId?[row.propertyId]:[])}},select:{id:true,name:true,cityId:true,regionId:true}}),
      this.tx.operationTask.findMany({where:{organizationId:this.organizationId,id:{in:entries.flatMap(row=>row.taskId?[row.taskId]:[])}},select:{id:true,state:true,assignedToPersonId:true,assignedToUserAccountId:true}}),
      this.tx.teamCompensation.findMany({where:{organizationId:this.organizationId,id:{in:entries.map(row=>row.compensationId)}},select:{id:true,version:true,effectiveFrom:true,assignment:{select:{role:{select:{name:true}}}}}})
    ]);
    const personMap=new Map(people.map(row=>[row.id,row])),propertyMap=new Map(properties.map(row=>[row.id,row])),taskMap=new Map(tasks.map(row=>[row.id,row])),contractMap=new Map(contracts.map(row=>[row.id,row]));
    return entries.map(entry=>{const person=personMap.get(entry.personId),compensation=contractMap.get(entry.compensationId);if(!person||!compensation)throw Error("Actual monthly source labels unavailable");return{id:entry.assignmentId,personId:entry.personId,propertyId:entry.propertyId,taskId:entry.taskId,person,property:entry.propertyId?propertyMap.get(entry.propertyId)??null:null,task:entry.taskId?taskMap.get(entry.taskId)??null:null,compensation,completionEvent:null,sourceCity:entry.sourceCityId?{id:entry.sourceCityId,regionId:entry.sourceRegionId}:null,sourceRegion:entry.sourceRegionId?{id:entry.sourceRegionId}:null};});
  }
  async work(input:{startsAt:Date;endsAt:Date;after?:{at:string;id:string}}){
    return this.tx.$queryRaw<Array<{id:string;at:string}>>(Prisma.sql`SELECT id,
      to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM operation_task WHERE organization_id=${this.organizationId}::uuid AND state='COMPLETED'
      AND completed_at>=${input.startsAt} AND completed_at<${input.endsAt}
      ${input.after?Prisma.sql`AND (completed_at,id)<(${input.after.at}::timestamptz,${input.after.id}::uuid)`:Prisma.empty}
      ORDER BY completed_at DESC,id DESC LIMIT 26`);
  }
  assignments(people:readonly string[],startsAt:Date,endsAt:Date){
    return this.tx.roleAssignment.findMany({where:{organizationId:this.organizationId,personId:{in:[...new Set(people)]},validFrom:{lt:endsAt},
      OR:[{validTo:null},{validTo:{gt:startsAt}}]},select:{id:true,personId:true},orderBy:{id:"asc"}});
  }
  async display(entries:readonly {key:string;taskId:string;personId:string;propertyId:string;compensationId:string;completionEvent:CompensationDisplaySource["completionEvent"]}[]):Promise<CompensationDisplaySource[]>{
    const [people,properties,tasks,contracts]=await Promise.all([
      this.tx.person.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.personId))]}},select:{id:true,displayName:true,userAccounts:{select:{id:true}}}}),
      this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.propertyId))]}},select:{id:true,name:true,cityId:true,regionId:true}}),
      this.tx.operationTask.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.taskId))]}},select:{id:true,state:true,assignedToPersonId:true,assignedToUserAccountId:true}}),
      this.tx.teamCompensation.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.compensationId))]}},select:{id:true,version:true,effectiveFrom:true,assignment:{select:{role:{select:{name:true}}}}}})
    ]);
    const personMap=new Map(people.map(row=>[row.id,row])),propertyMap=new Map(properties.map(row=>[row.id,row])),taskMap=new Map(tasks.map(row=>[row.id,row])),contractMap=new Map(contracts.map(row=>[row.id,row]));
    return entries.map(entry=>{
      const person=personMap.get(entry.personId),property=propertyMap.get(entry.propertyId),task=taskMap.get(entry.taskId),compensation=contractMap.get(entry.compensationId);
      if(!person||!property||!task||!compensation)throw Error("Actual source labels unavailable");
      return{id:entry.key,taskId:entry.taskId,personId:entry.personId,propertyId:entry.propertyId,person,property,task,compensation,completionEvent:entry.completionEvent};
    });
  }
  async editor(){
    const [organization,currencies]=await Promise.all([this.tx.organization.findUniqueOrThrow({where:{id:this.organizationId},select:{baseCurrency:true}}),
      this.tx.currency.findMany({where:{minorUnit:{lte:2}},orderBy:{code:"asc"},select:{code:true}})]);
    return{baseCurrency:organization.baseCurrency,currencies:currencies.map(row=>row.code)};
  }
}
