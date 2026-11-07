import type { AuthContext } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { assertAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { TenantTransaction } from "@/platform/db/tenant";
import { DocumentSearchRepository } from "../infrastructure/document-search-repository";
import { documentSourceRuleScopes, type DocumentSourceFacts } from "../infrastructure/document-repository";
import { ConfigRuleRepository, type ResolvedConfigRule, type ConfigScopeCandidate } from "@/platform/config/config-rule-repository";
import { documentArchivePolicyKey } from "../domain/document-policy";
import { DocumentAccessError, documentSourceReferenceSchema } from "../domain/document-command";
import type { DocumentActorContext } from "./document-archive";

/** A private, bounded read phase. The publisher must open a fresh phase after its audit. */
export class DocumentArchiveReadPhase {
  private rules=new Map<string,ResolvedConfigRule|null>();
  private constructor(private readonly tx:TenantTransaction,private readonly organizationId:string,private readonly actorId:string,
    private readonly cap:string,private readonly stored:AuthContext,private readonly at:number,private readonly reads:DocumentSearchRepository){}
  static async create(ctx:DocumentActorContext,tx:TenantTransaction){
    const reads=new DocumentSearchRepository(tx,ctx.organizationId),now=await reads.clock(),stored=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    return new DocumentArchiveReadPhase(tx,ctx.organizationId,ctx.actorId,commandFingerprint(captureAuthorizationCap(ctx.authContext)),restoreAuthorizationCap(captureAuthorizationCap(stored)),now.getTime(),reads);
  }
  repository(ctx:DocumentActorContext,tx:TenantTransaction){this.bind(ctx,tx);return this.reads;}
  async prepare(ctx:DocumentActorContext,tx:TenantTransaction,ids:readonly string[],asOf:Date){
    this.bind(ctx,tx);await this.reads.prepareMetadata(ids,asOf);const references=[...new Map(this.reads.preparedRoots().map(root=>{const reference=documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId});return[reference.kind+":"+reference.id,reference]as const;})).values()];
    await this.reads.prepareDocumentSources(references);const groups=new Map<string,ConfigScopeCandidate[]>();for(const reference of references){const native=await this.reads.documentSource(reference);if(!native)continue;try{this.check(ctx,tx,native.checks);}catch(error){if(error instanceof DocumentAccessError)continue;throw error;}groups.set(reference.kind+":"+reference.id,documentSourceRuleScopes(native.resource));}
    this.rules=groups.size?await new ConfigRuleRepository(tx,this.organizationId).resolveScopeGroups(documentArchivePolicyKey,groups,new Date(this.at)):new Map<string,ResolvedConfigRule|null>();
  }
  async archiveRule(ctx:DocumentActorContext,tx:TenantTransaction,native:DocumentSourceFacts){this.bind(ctx,tx);const key=native.reference.kind+":"+native.reference.id;return this.rules.has(key)?this.rules.get(key)??null:new ConfigRuleRepository(tx,this.organizationId).resolve({key:documentArchivePolicyKey,scopes:documentSourceRuleScopes(native.resource),asOf:new Date(this.at)});}
  knownAbsentSignedArtifact(ctx:DocumentActorContext,tx:TenantTransaction,documentId:string){this.bind(ctx,tx);return this.reads.knownAbsentSignedArtifact(documentId);}
  instant(ctx:DocumentActorContext,tx:TenantTransaction){this.bind(ctx,tx);return new Date(this.at);}
  check(ctx:DocumentActorContext,tx:TenantTransaction,checks:readonly CurrentAuthorityCheck[]){this.bind(ctx,tx);assertAccountAuthorization(ctx,this.stored,new Date(this.at),checks,new DocumentAccessError());}
  private bind(ctx:DocumentActorContext,tx:TenantTransaction){if(tx!==this.tx||ctx.organizationId!==this.organizationId||ctx.actorId!==this.actorId||commandFingerprint(captureAuthorizationCap(ctx.authContext))!==this.cap)throw new DocumentAccessError();}
}
