import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export type OnboardingDocumentSourceHead={id:string;organizationId:string;sessionId:string;number:number;ownerId:string;propertyId:string;createdBy:string;createdAt:Date;sourceFingerprint:string;payloadSha256:string;reviewVersion:string;reviewTuple:string;ownerVersion:string;ownerTuple:string;ownerArchivedAt:Date|null;propertyVersion:string;propertyTuple:string;propertyArchivedAt:Date|null;propertyStatus:string;cityId:string|null;regionId:string|null;propertyName:string};
export class OnboardingDocumentSourceRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 candidates(query:string,before:string|undefined,take:number){const pattern="%"+query.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")+"%";return this.tx.$queryRaw<Array<{id:string;label:string}>>(Prisma.sql`
  SELECT r.id,p.name AS label FROM property_onboarding_revision r JOIN owner o ON o.organization_id=r.organization_id AND o.id=r.owner_id JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
  WHERE r.organization_id=${this.organizationId}::uuid AND r.step='REVIEW' AND r.mode='VALIDATE' AND o.archived_at IS NULL AND p.archived_at IS NULL
   AND (${before??null}::uuid IS NULL OR r.id<${before??null}::uuid) AND (p.name ILIKE ${pattern} OR r.id::text=${query}) ORDER BY r.id DESC LIMIT ${take}`);}
 async heads(ids:readonly string[]){if(!ids.length)return[];return this.tx.$queryRaw<OnboardingDocumentSourceHead[]>(Prisma.sql`
  SELECT r.id,r.organization_id AS "organizationId",r.session_id AS "sessionId",r.number,r.owner_id AS "ownerId",r.property_id AS "propertyId",r.created_by AS "createdBy",r.created_at AS "createdAt",r.source_fingerprint AS "sourceFingerprint",r.payload_sha256 AS "payloadSha256",r.xmin::text AS "reviewVersion",r.ctid::text AS "reviewTuple",
   o.xmin::text AS "ownerVersion",o.ctid::text AS "ownerTuple",o.archived_at AS "ownerArchivedAt",p.xmin::text AS "propertyVersion",p.ctid::text AS "propertyTuple",p.archived_at AS "propertyArchivedAt",p.status::text AS "propertyStatus",p.city_id AS "cityId",p.region_id AS "regionId",p.name AS "propertyName"
  FROM property_onboarding_revision r JOIN owner o ON o.organization_id=r.organization_id AND o.id=r.owner_id JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
  WHERE r.organization_id=${this.organizationId}::uuid AND r.id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) AND r.step='REVIEW' AND r.mode='VALIDATE' ORDER BY r.id`);}
}
