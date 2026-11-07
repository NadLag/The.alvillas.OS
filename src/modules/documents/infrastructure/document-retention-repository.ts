import type { DocumentRetentionRevision, Prisma } from "@prisma/client";
import { DocumentRepository } from "./document-repository";

/** Metadata history belongs to the native immutable version, never an editable balance or artifact. */
export class DocumentRetentionRepository extends DocumentRepository {
  currentRetention(versionId:string):Promise<DocumentRetentionRevision|null>{
    return this.tx.documentRetentionRevision.findFirst({where:{organizationId:this.organizationId,versionId},orderBy:{number:"desc"}});
  }
  retentionRevisions(versionId:string,before?:number):Promise<DocumentRetentionRevision[]>{
    return this.tx.documentRetentionRevision.findMany({where:{organizationId:this.organizationId,versionId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:11});
  }
  retentionByNonce(createdBy:string,commandKey:string):Promise<DocumentRetentionRevision|null>{
    return this.tx.documentRetentionRevision.findFirst({where:{organizationId:this.organizationId,createdBy,commandKey}});
  }
  retentionNonceOwner(commandKey:string):Promise<Pick<DocumentRetentionRevision,"createdBy">|null>{
    return this.tx.documentRetentionRevision.findFirst({where:{organizationId:this.organizationId,commandKey},select:{createdBy:true}});
  }
  appendRetention(data:Omit<Prisma.DocumentRetentionRevisionUncheckedCreateInput,"organizationId">):Promise<DocumentRetentionRevision>{
    return this.tx.documentRetentionRevision.create({data:{...data,organizationId:this.organizationId}});
  }
}
