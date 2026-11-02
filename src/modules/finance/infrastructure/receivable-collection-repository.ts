import{Prisma}from"@prisma/client";
import type{TenantTransaction}from"@/platform/db/tenant";
import{z}from"zod";
import{ReceivableAssignmentRepository,receivableOriginalSnapshot}from"./receivable-assignment-repository";
import{receivableAssignmentViewSchema}from"../domain/receivable-assignment";
import{receivableCollectionViewSchema}from"../domain/receivable-collection";
const id=z.uuid(),instant=z.iso.datetime({offset:true}),destination=z.object({id,organizationId:id,code:z.string(),name:z.string(),accountType:z.string(),normalSide:z.string(),archivedAt:instant.nullable(),
 teamWallet:z.object({id,personId:id,person:z.object({archivedAt:instant.nullable()}).strict()}).strict().nullable()}).strict();
export const receivableCollectionSourceSnapshot=z.object({schemaVersion:z.literal(1),assignment:receivableAssignmentViewSchema,original:receivableOriginalSnapshot,destination}).strict();
export const receivableCollectionReversalSourceSnapshot=z.object({schemaVersion:z.literal(1),collection:receivableCollectionViewSchema,journal:receivableOriginalSnapshot}).strict();
const include={destination:{select:{id:true,code:true,name:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}},reversal:{include:{transaction:{include:{postings:true}}}},transaction:{include:{postings:true,reversedByTransactions:{include:{postings:true}}}},assignment:{include:{release:true}}}as const;
export class ReceivableCollectionRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 lockIntent(key:string){return new ReceivableAssignmentRepository(this.tx,this.organizationId).lockIntent(key);}
 get(id:string){return this.tx.receivableCollection.findFirst({where:{organizationId:this.organizationId,id},include});}
 byKey(idempotencyKey:string){return this.tx.receivableCollection.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include});}
 reversalByKey(idempotencyKey:string){return this.tx.receivableCollectionReversal.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include:{collection:{include}}});}
 history(after?:string,assignmentId?:string){return this.tx.receivableCollection.findMany({where:{organizationId:this.organizationId,...after?{id:{gt:after}}:{},...assignmentId?{assignmentId}:{}},orderBy:{id:"asc"},take:51,include});}
 async commandKeyUsed(key:string){return(await new ReceivableAssignmentRepository(this.tx,this.organizationId).commandKind(key))!==null;}
 create(data:Omit<Prisma.ReceivableCollectionUncheckedCreateInput,"organizationId"|"reversal">){return this.tx.receivableCollection.create({data:{...data,organizationId:this.organizationId},include});}
 reverse(data:Omit<Prisma.ReceivableCollectionReversalUncheckedCreateInput,"organizationId">){return this.tx.receivableCollectionReversal.create({data:{...data,organizationId:this.organizationId},include:{collection:{include}}});}
 async source(assignmentId:string,destinationAccountId:string,receivedAt:Date){const[row]=await this.tx.$queryRaw<Array<{source:Prisma.JsonValue|null;eligible:boolean}>>(Prisma.sql`
  SELECT app_receivable_collection_source(${this.organizationId}::uuid,${assignmentId}::uuid,${destinationAccountId}::uuid) source,
   EXISTS(SELECT 1 FROM receivable_assignment a JOIN posting p ON p.organization_id=a.organization_id AND p.id=a.posting_id
    JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
    WHERE a.organization_id=${this.organizationId}::uuid AND a.id=${assignmentId}::uuid AND t.occurred_at<=${receivedAt}::timestamptz) eligible`);
  return row?.source?{snapshot:receivableCollectionSourceSnapshot.parse(row.source),eligible:row.eligible}:null;
 }
 async reversalSource(id:string){const[row]=await this.tx.$queryRaw<Array<{source:Prisma.JsonValue|null}>>(Prisma.sql`SELECT app_receivable_collection_reversal_source(${this.organizationId}::uuid,${id}::uuid) source`);return row?.source?receivableCollectionReversalSourceSnapshot.parse(row.source):null;}
 async movements(assignmentId:string,currency:string,exceptCollectionId?:string){
  const[row]=await this.tx.$queryRaw<Array<{collected:string;fingerprint:string}>>(Prisma.sql`SELECT collected::text,fingerprint FROM app_receivable_collection_movements(${this.organizationId}::uuid,${assignmentId}::uuid,${currency},${exceptCollectionId??null}::uuid)`);
  if(!row)throw Error("Actual receivable movement aggregate required");return row;
 }
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");}
}
