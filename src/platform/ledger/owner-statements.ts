import type { TenantTransaction } from "@/platform/db/tenant";
import { OwnerStatementRepository } from "./owner-statement-repository";
import { buildOwnerStatement } from "./owner-statement";

export async function readOwnerLedgerStatement(tx:TenantTransaction,organizationId:string,input:{ownerId:string;ownerName:string;propertyId?:string;propertyName:string|null;currency:string;startsAt:Date;endsAt:Date}){
  const postings=await new OwnerStatementRepository(tx,organizationId).listOwnerLedgerPostings({ownerId:input.ownerId,propertyId:input.propertyId,periodEnd:input.endsAt,currency:input.currency,includeLocations:false});
  return buildOwnerStatement({organizationId,ownerId:input.ownerId,ownerName:input.ownerName,propertyId:input.propertyId??null,propertyName:input.propertyName,periodStart:input.startsAt,periodEnd:input.endsAt,currency:input.currency,postings});
}
export async function hasOwnerLedgerPropertyHistory(tx:TenantTransaction,organizationId:string,ownerId:string,propertyId:string){return new OwnerStatementRepository(tx,organizationId).hasOwnerLedgerPropertyHistory(ownerId,propertyId)}
