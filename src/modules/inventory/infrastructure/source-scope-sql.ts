import {Prisma} from "@prisma/client";
import type {Scope} from "@/platform/authz/authorize";
/** Native property aliases remain shared by both catalog and reservation pages. */
export function inventorySourceSelection(scopes:readonly Scope[],reservation=false,propertyAlias:"p"|"rp"="p"){
 const propertyId=propertyAlias==="p"?Prisma.sql`p.id`:Prisma.sql`rp.id`,city=propertyAlias==="p"?Prisma.sql`COALESCE(p.city_id::text,p.city)`:Prisma.sql`COALESCE(rp.city_id::text,rp.city)`,region=propertyAlias==="p"?Prisma.sql`COALESCE(p.region_id::text,p.region)`:Prisma.sql`COALESCE(rp.region_id::text,rp.region)`;
 const clauses=scopes.flatMap(scope=>{const kind=scope.scopeType??scope.resourceType,id=scope.scopeId??scope.resourceId;if(kind==="organization")return[Prisma.sql`TRUE`];if(!id)return[];
  if(reservation&&kind==="reservation")return[Prisma.sql`r.id::text=${id}`];if(kind==="property")return[Prisma.sql`${propertyId}::text=${id}`];if(kind==="city")return[Prisma.sql`${city}=${id}`];if(kind==="region")return[Prisma.sql`${region}=${id}`];return[];});
 return clauses.length?Prisma.sql`(${Prisma.join(clauses," OR ")})`:Prisma.sql`FALSE`;
}
