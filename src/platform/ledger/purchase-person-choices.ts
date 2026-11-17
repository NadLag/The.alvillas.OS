import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {TeamRepository} from "@/modules/identity/infrastructure/team-repository";
/** Reuse Identity's SQL scope rules before pagination and retain the caller cap. */
export async function nativePurchasePersonChoices(actor:AccountActorContext,tx:TenantTransaction,query:string,page:number){const repository=new TeamRepository(tx,actor.organizationId),stored={...await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),personId:actor.authContext.personId},held=await repository.visiblePeople(actor.authContext,query,page),current=await repository.visiblePeople(stored,query,page),ids=new Set(current.people.filter(person=>!person.archivedAt).map(person=>person.id));return{items:held.people.filter(person=>ids.has(person.id)&&!person.archivedAt).map(person=>({id:person.id,label:person.displayName})),next:page*25<Math.min(held.total,current.total)?String(page+1):null};}
