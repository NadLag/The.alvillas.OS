import type { Prisma } from "@prisma/client";
import { readOwnerLedgerStatement,hasOwnerLedgerPropertyHistory } from "@/platform/ledger/owner-statements";
import { LedgerCalendarRepository } from "./ledger-calendar-repository";

const ownerSelect={id:true,displayName:true,archivedAt:true,propertyOwners:{select:{property:{select:{id:true,name:true,cityId:true,regionId:true}}}}} satisfies Prisma.OwnerSelect;
export type OwnerLedgerOwner=Prisma.OwnerGetPayload<{select:typeof ownerSelect}>;
type Scope={ownerId:string;propertyId?:string;currency:string};
type Range={startsAt:Date;endsAt:Date};

export class OwnerLedgerRepository extends LedgerCalendarRepository{
  override range(fromOn:string,toOn:string,timezone:string):Promise<Range>{return super.range(fromOn,toOn,timezone)}
  owner(id:string){return this.tx.owner.findFirst({where:{organizationId:this.organizationId,id},select:ownerSelect})}
  owners(input:{query?:string;after?:string}){return this.tx.owner.findMany({where:{organizationId:this.organizationId,...(input.after?{id:{gt:input.after}}:{}),
    ...(input.query?{displayName:{contains:input.query,mode:"insensitive" as const}}:{})},select:ownerSelect,orderBy:{id:"asc"},take:100})}
  property(id:string){return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,name:true,cityId:true,regionId:true}})}
  hasPropertyHistory(ownerId:string,propertyId:string){return hasOwnerLedgerPropertyHistory(this.tx,this.organizationId,ownerId,propertyId)}
  statement(input:Scope,range:Range,ownerName:string,propertyName:string|null){return readOwnerLedgerStatement(this.tx,this.organizationId,{...input,...range,ownerName,propertyName})}
}
