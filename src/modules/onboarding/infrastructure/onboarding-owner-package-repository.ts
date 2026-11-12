import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export type OnboardingOwnerAccessWitness={id:string;ownerId:string;accountId:string;accountStatus:string;personId:string|null;personArchivedAt:Date|null;accessVersion:string;accessTuple:string;accountVersion:string;accountTuple:string;personVersion:string|null;personTuple:string|null;ownershipId:string;ownershipVersion:string;ownershipTuple:string};
export class OnboardingOwnerPackageRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 packageById(id:string){return this.tx.ownerOnboardingPackage.findFirst({where:{organizationId:this.organizationId,id}});}
 packageByNonce(commandKey:string){return this.tx.ownerOnboardingPackage.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 packageItems(packageId:string){return this.tx.ownerOnboardingPackageItem.findMany({where:{organizationId:this.organizationId,packageId},orderBy:{locale:"asc"},take:4});}
 createPackage(input:Omit<Prisma.OwnerOnboardingPackageUncheckedCreateInput,"organizationId">){return this.tx.ownerOnboardingPackage.create({data:{...input,organizationId:this.organizationId}});}
 createPackageItem(input:Omit<Prisma.OwnerOnboardingPackageItemUncheckedCreateInput,"organizationId">){return this.tx.ownerOnboardingPackageItem.create({data:{...input,organizationId:this.organizationId}});}
 async validatePackageBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS owner_package_birth_guard,owner_package_item_birth_guard IMMEDIATE`);}
 /** Complete tenant-bound account/access/ownership metadata; no contact fields or synthetic grants. */
 async ownerAccessWitnesses(ownerId:string,propertyId:string){return this.tx.$queryRaw<OnboardingOwnerAccessWitness[]>(Prisma.sql`
  SELECT a.id,a.owner_id AS "ownerId",a.user_account_id AS "accountId",u.status::text AS "accountStatus",u.person_id AS "personId",p.archived_at AS "personArchivedAt",
   a.xmin::text AS "accessVersion",a.ctid::text AS "accessTuple",u.xmin::text AS "accountVersion",u.ctid::text AS "accountTuple",p.xmin::text AS "personVersion",p.ctid::text AS "personTuple",
   po.id AS "ownershipId",po.xmin::text AS "ownershipVersion",po.ctid::text AS "ownershipTuple"
  FROM owner_portal_access a JOIN user_account u ON u.organization_id=a.organization_id AND u.id=a.user_account_id
  LEFT JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
  JOIN owner o ON o.organization_id=a.organization_id AND o.id=a.owner_id AND o.archived_at IS NULL
  JOIN property_owner po ON po.organization_id=a.organization_id AND po.owner_id=a.owner_id AND po.property_id=${propertyId}::uuid AND po.archived_at IS NULL
  JOIN property target ON target.organization_id=po.organization_id AND target.id=po.property_id AND target.archived_at IS NULL
  WHERE a.organization_id=${this.organizationId}::uuid AND a.owner_id=${ownerId}::uuid AND a.archived_at IS NULL ORDER BY a.id,po.id`);}
}
