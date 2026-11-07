import type { AuthContext } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { assertAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { TenantTransaction } from "@/platform/db/tenant";
import { DocumentRepository } from "../infrastructure/document-repository";
import { DocumentAccessError } from "../domain/document-command";
import type { DocumentActorContext } from "./document-archive";

/** A private, bounded read phase. The publisher must open a fresh phase after its audit. */
export class DocumentArchiveReadPhase {
  private constructor(private readonly tx:TenantTransaction,private readonly organizationId:string,private readonly actorId:string,
    private readonly cap:string,private readonly stored:AuthContext,private readonly at:number){}
  static async create(ctx:DocumentActorContext,tx:TenantTransaction){
    const now=await new DocumentRepository(tx,ctx.organizationId).clock(),stored=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    return new DocumentArchiveReadPhase(tx,ctx.organizationId,ctx.actorId,commandFingerprint(captureAuthorizationCap(ctx.authContext)),restoreAuthorizationCap(captureAuthorizationCap(stored)),now.getTime());
  }
  instant(ctx:DocumentActorContext,tx:TenantTransaction){this.bind(ctx,tx);return new Date(this.at);}
  check(ctx:DocumentActorContext,tx:TenantTransaction,checks:readonly CurrentAuthorityCheck[]){this.bind(ctx,tx);assertAccountAuthorization(ctx,this.stored,new Date(this.at),checks,new DocumentAccessError());}
  private bind(ctx:DocumentActorContext,tx:TenantTransaction){if(tx!==this.tx||ctx.organizationId!==this.organizationId||ctx.actorId!==this.actorId||commandFingerprint(captureAuthorizationCap(ctx.authContext))!==this.cap)throw new DocumentAccessError();}
}
