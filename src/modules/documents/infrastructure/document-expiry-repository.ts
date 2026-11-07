import type { DocumentExpiryRevision, DocumentExpiryReminder, Prisma } from "@prisma/client";
import { DocumentRepository } from "./document-repository";

export class DocumentExpiryRepository extends DocumentRepository {
  async expiryCalendar():Promise<{timezone:string}|null>{
    return this.tx.organizationProfile.findUnique({where:{organizationId:this.organizationId},select:{timezone:true}});
  }
  async expiryRecipient(id:string):Promise<{personId:string}|null>{
    return this.tx.userAccount.findFirst({where:{organizationId:this.organizationId,id,status:"ACTIVE",person:{archivedAt:null}},select:{personId:true}});
  }
  async expiryRevision(id:string):Promise<DocumentExpiryRevision|null>{
    return this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,id}});
  }
  async currentExpiry(versionId:string):Promise<DocumentExpiryRevision|null>{
    return this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,versionId},orderBy:{number:"desc"}});
  }
  async expiryRevisions(versionId:string,before?:number):Promise<DocumentExpiryRevision[]>{
    return this.tx.documentExpiryRevision.findMany({where:{organizationId:this.organizationId,versionId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:51});
  }
  async expiryByNonce(createdBy:string,commandKey:string):Promise<DocumentExpiryRevision|null>{
    return this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,createdBy,commandKey}});
  }
  async expiryNonceOwner(commandKey:string):Promise<Pick<DocumentExpiryRevision,"createdBy">|null>{
    return this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,commandKey},select:{createdBy:true}});
  }
  async appendExpiry(data:Omit<Prisma.DocumentExpiryRevisionUncheckedCreateInput,"organizationId">):Promise<DocumentExpiryRevision>{
    return this.tx.documentExpiryRevision.create({data:{...data,organizationId:this.organizationId}});
  }
  async expiryReminder(id:string):Promise<DocumentExpiryReminder|null>{
    return this.tx.documentExpiryReminder.findFirst({where:{organizationId:this.organizationId,id}});
  }
  async expiryReminderByKey(idempotencyKey:string):Promise<DocumentExpiryReminder|null>{
    return this.tx.documentExpiryReminder.findFirst({where:{organizationId:this.organizationId,idempotencyKey}});
  }
  async existingExpiryOccurrences(keys:readonly string[]):Promise<Set<string>>{
    const rows=await this.tx.documentExpiryReminder.findMany({where:{organizationId:this.organizationId,idempotencyKey:{in:[...keys]}},select:{idempotencyKey:true}});
    return new Set(rows.map(row=>row.idempotencyKey));
  }
  async appendExpiryReminder(data:Omit<Prisma.DocumentExpiryReminderUncheckedCreateInput,"organizationId">):Promise<DocumentExpiryReminder>{
    return this.tx.documentExpiryReminder.create({data:{...data,organizationId:this.organizationId}});
  }
  async expiryCandidates(typeKeys:readonly string[],until:Date,before?:string):Promise<Array<Pick<DocumentExpiryRevision,"id"|"versionId"|"expiresOn">>>{
    return this.tx.documentExpiryRevision.findMany({where:{organizationId:this.organizationId,expiresOn:{not:null,lte:until},next:{none:{}},...before?{id:{lt:before}}:{},
      version:{document:{archivedAt:null,kind:{in:["FILE","INSTANCE"]},typeKey:{in:[...typeKeys]}}}},select:{id:true,versionId:true,expiresOn:true},orderBy:{id:"desc"},take:101});
  }
}
