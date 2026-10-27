import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { readOwnerLedgerStatement,hasOwnerLedgerPropertyHistory } from "@/platform/ledger/owner-statements";

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
  async defaults(now:Date,timezone:string){const [row]=await this.tx.$queryRaw<Array<{fromOn:string;toOn:string}>>(Prisma.sql`SELECT
    to_char(${now}::timestamptz AT TIME ZONE ${timezone},'YYYY-MM-01') AS "fromOn",
    to_char(date_trunc('month',${now}::timestamptz AT TIME ZONE ${timezone})+interval '1 month'-interval '1 day','YYYY-MM-DD') AS "toOn"`);return row}
  async range(fromOn:string,toOn:string,timezone:string){const [row]=await this.tx.$queryRaw<Array<Range>>(Prisma.sql`SELECT
    (${fromOn}::date::timestamp AT TIME ZONE ${timezone}) AS "startsAt",
    ((${toOn}::date+1)::timestamp AT TIME ZONE ${timezone}) AS "endsAt"`);return row}
  hasPropertyHistory(ownerId:string,propertyId:string){return hasOwnerLedgerPropertyHistory(this.tx,this.organizationId,ownerId,propertyId)}
  statement(input:Scope,range:Range,ownerName:string,propertyName:string|null){return readOwnerLedgerStatement(this.tx,this.organizationId,{...input,...range,ownerName,propertyName})}
}
