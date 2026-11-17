import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
export class SupplierPriceRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 insertReference(input:{id:string;supplierId:string;currency:string;createdBy:string}){return this.tx.$executeRaw(Prisma.sql`INSERT INTO supplier_price_list_version(id,organization_id,supplier_id,config_rule_id,currency,created_by)VALUES(${input.id}::uuid,${this.organizationId}::uuid,${input.supplierId}::uuid,${input.id}::uuid,${input.currency},${input.createdBy}::uuid)`);}
 async head(id:string):Promise<{id:string;supplierId:string;configRuleId:string;scopeType:string;scopeId:string|null;createdAt:Date}|null>{return(await this.tx.$queryRaw<Array<{id:string;supplierId:string;configRuleId:string;scopeType:string;scopeId:string|null;createdAt:Date}>>(Prisma.sql`SELECT p.id,p.supplier_id AS "supplierId",p.config_rule_id AS "configRuleId",c.scope_type AS "scopeType",c.scope_id AS "scopeId",p.created_at AS "createdAt" FROM supplier_price_list_version p JOIN config_rule c ON c.organization_id=p.organization_id AND c.id=p.config_rule_id WHERE p.organization_id=${this.organizationId}::uuid AND p.id=${id}::uuid`))[0]??null;}
}
