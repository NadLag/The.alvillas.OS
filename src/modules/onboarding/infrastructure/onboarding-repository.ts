import {Prisma,type PropertyOnboardingRevision,type PropertyOnboardingSession} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export type OnboardingDirectoryPosition={createdAt:Date;sessionId:string};
export class OnboardingRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async clock(){const rows=await this.tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;return rows[0].now;}
 async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":onboarding:command:"+commandKey},0))`);}
 async lockSession(sessionId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":onboarding:session:"+sessionId},0))`);}
 session(sessionId:string){return this.tx.propertyOnboardingSession.findFirst({where:{organizationId:this.organizationId,id:sessionId}});}
 current(sessionId:string){return this.tx.propertyOnboardingRevision.findFirst({where:{organizationId:this.organizationId,sessionId},orderBy:{number:"desc"}});}
 configurationStepHeads(sessionId:string,number:number){return this.tx.$queryRaw<Array<{id:string;previousId:string|null;step:string;number:number;ownerId:string;propertyId:string|null;mode:string;createdBy:string;createdAt:Date;sourceFingerprint:string;sourceSnapshot:Prisma.JsonValue;payloadSha256:string;rowVersion:string;tuple:string}>>(Prisma.sql`SELECT DISTINCT ON(step) id,previous_id AS "previousId",step,number,owner_id AS "ownerId",property_id AS "propertyId",mode,created_by AS "createdBy",created_at AS "createdAt",source_fingerprint AS "sourceFingerprint",source_snapshot AS "sourceSnapshot",payload_sha256 AS "payloadSha256",xmin::text AS "rowVersion",ctid::text AS tuple FROM property_onboarding_revision WHERE organization_id=${this.organizationId}::uuid AND session_id=${sessionId}::uuid AND number<=${number} ORDER BY step,number DESC`);}
 byId(id:string){return this.tx.propertyOnboardingRevision.findFirst({where:{organizationId:this.organizationId,id}});}
 byNonce(commandKey:string){return this.tx.propertyOnboardingRevision.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 history(sessionId:string,before?:number){return this.tx.propertyOnboardingRevision.findMany({where:{organizationId:this.organizationId,sessionId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:21});}
 createSession(input:Omit<Prisma.PropertyOnboardingSessionUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingSession>{return this.tx.propertyOnboardingSession.create({data:{...input,organizationId:this.organizationId}});}
 createRevision(input:Omit<Prisma.PropertyOnboardingRevisionUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingRevision>{return this.tx.propertyOnboardingRevision.create({data:{...input,organizationId:this.organizationId}});}
 revisionRows(ids:readonly string[]){return this.tx.propertyOnboardingRevision.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}}});}
 directory(asOf:Date,before?:OnboardingDirectoryPosition){
  return this.tx.$queryRaw<Array<{sessionId:string;createdAt:Date;revisionId:string}>>(Prisma.sql`SELECT s.id AS "sessionId",s.created_at AS "createdAt",r.id AS "revisionId" FROM property_onboarding_session s JOIN LATERAL(SELECT id FROM property_onboarding_revision WHERE organization_id=s.organization_id AND session_id=s.id ORDER BY number DESC LIMIT 1) r ON true WHERE s.organization_id=${this.organizationId}::uuid AND s.created_at<=${asOf} ${before?Prisma.sql`AND (s.created_at,s.id)<(${before.createdAt},${before.sessionId}::uuid)`:Prisma.empty} ORDER BY s.created_at DESC,s.id DESC LIMIT 21`);
 }
 currentHeads(sessionIds:readonly string[]){return this.tx.$queryRaw<Array<{sessionId:string;id:string}>>(Prisma.sql`SELECT DISTINCT ON(session_id) session_id AS "sessionId",id FROM property_onboarding_revision WHERE organization_id=${this.organizationId}::uuid AND session_id=ANY(${[...sessionIds]}::uuid[]) ORDER BY session_id,number DESC`);}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS property_onboarding_revision_events_guard,property_onboarding_session_birth_guard IMMEDIATE`);}
}
