import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { readOwnerLedgerStatement,hasOwnerLedgerPropertyHistory } from "@/platform/ledger/owner-statements";
import { calendarDateAt } from "@/i18n/format";
import { calendarDateStart } from "@/platform/time/calendar";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";

const ownerSelect={id:true,displayName:true,archivedAt:true,propertyOwners:{select:{property:{select:{id:true,name:true,cityId:true,regionId:true}}}}} satisfies Prisma.OwnerSelect;
export type OwnerLedgerOwner=Prisma.OwnerGetPayload<{select:typeof ownerSelect}>;
type Scope={ownerId:string;propertyId?:string;currency:string};
type Range={startsAt:Date;endsAt:Date};

export class OwnerLedgerRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  owner(id:string){return this.tx.owner.findFirst({where:{organizationId:this.organizationId,id},select:ownerSelect})}
  owners(input:{query?:string;after?:string}){return this.tx.owner.findMany({where:{organizationId:this.organizationId,...(input.after?{id:{gt:input.after}}:{}),
    ...(input.query?{displayName:{contains:input.query,mode:"insensitive" as const}}:{})},select:ownerSelect,orderBy:{id:"asc"},take:100})}
  property(id:string){return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,name:true,cityId:true,regionId:true}})}
  async settings(){const [organization,profile,currencies]=await Promise.all([
    this.tx.organization.findUniqueOrThrow({where:{id:this.organizationId},select:{baseCurrency:true}}),this.tx.organizationProfile.findFirst({where:{organizationId:this.organizationId},select:{timezone:true}}),
    this.tx.currency.findMany({orderBy:{code:"asc"},select:{code:true}})]);return{baseCurrency:organization.baseCurrency,timezone:profile?.timezone,currencies}}
  defaults(now:Date,timezone:string){
    requireCurrentTimezoneData();
    const fromOn=calendarDateAt(now,timezone).slice(0,7)+"-01",last=new Date(fromOn+"T00:00:00.000Z");
    last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
    return Promise.resolve({fromOn,toOn:last.toISOString().slice(0,10)});
  }
  range(fromOn:string,toOn:string,timezone:string):Promise<Range>{
    requireCurrentTimezoneData();
    const next=new Date(toOn+"T00:00:00.000Z");next.setUTCDate(next.getUTCDate()+1);
    return Promise.resolve({startsAt:calendarDateStart(fromOn,timezone),endsAt:calendarDateStart(next.toISOString().slice(0,10),timezone)});
  }
  hasPropertyHistory(ownerId:string,propertyId:string){return hasOwnerLedgerPropertyHistory(this.tx,this.organizationId,ownerId,propertyId)}
  statement(input:Scope,range:Range,ownerName:string,propertyName:string|null){return readOwnerLedgerStatement(this.tx,this.organizationId,{...input,...range,ownerName,propertyName})}
}
