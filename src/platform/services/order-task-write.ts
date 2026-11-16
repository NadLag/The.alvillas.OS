import type {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {AuthContext,Resource} from "@/platform/authz/authorize";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {configurationSourceClock} from "@/platform/config/property-source";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {taskResource} from "@/platform/authz/task-resource";
import {localizedTextSchema} from "@/i18n/content";
import {createOperationTask,transitionOperationTask} from "@/modules/reservations/application/operation-service";
import {OperationRepository} from "@/modules/reservations/infrastructure/operation-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {ReservationAuthorizationError,ReservationConflictError,ReservationConfigError,ReservationNotFoundError} from "@/modules/reservations/application/reservation-service";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderConfigurationError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
import {serviceOrderTaskPlanSchema} from "./order-task-contracts";
import {nativeServiceCatalogActor} from "./catalog-provider-source";

function nativeTaskError(error:unknown):never{
 if(error instanceof ReservationAuthorizationError)throw new ServiceOrderAccessError();
 if(error instanceof ReservationConflictError||error instanceof ReservationNotFoundError)throw new ServiceOrderConflictError();
 if(error instanceof ReservationConfigError)throw new ServiceOrderConfigurationError();throw error;
}
type Metadata={id:string;propertyId:string;reservationId:string;titleTranslations:unknown;serviceDate:Date;taskId:string|null};
type Boundary={stored:AuthContext;now:Date;scope:Pick<Resource,"organizationId"|"propertyId"|"reservationId"|"city"|"region">};
type Command={key:string;requestId:string};

export async function nativeServiceOrderTaskChoices(actor:AccountActorContext,tx:TenantTransaction,boundary:Boundary){
 if(!boundary.scope.propertyId||boundary.scope.organizationId!==actor.organizationId)throw new ServiceOrderAccessError();
 const rules=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:boundary.scope.propertyId,asOf:boundary.now}),metadata=await rules.resolveMetadata({key:"ops.checklists",scopes,asOf:boundary.now}),head=metadata?await rules.sourceMetadataWitness(metadata.id):null;if(!head)throw new ServiceOrderConfigurationError();
 const checks:CurrentAuthorityCheck[]=[{action:"view",unconditional:true,resource:{...boundary.scope,type:"config_rule",id:head.id,dataClass:"operational",occurredAt:head.createdAt}}];assertAccountAuthorization(actor,boundary.stored,boundary.now,checks,new ServiceOrderAccessError());
 const native=await new OperationRepository(tx,actor.organizationId).checklists(boundary.scope.propertyId),after=await rules.sourceMetadataWitness(head.id);if(!native||native.rule.id!==head.id||head.xmin!==after?.xmin||head.tuple!==after.tuple)throw new ServiceOrderConflictError();
 await recheckAccountAuthorization(actor,tx,await configurationSourceClock(tx,actor.organizationId),checks,new ServiceOrderAccessError());return{ruleId:head.id,ruleVersion:head.version,types:serviceOrderTaskPlanSchema.shape.type.options,priorities:serviceOrderTaskPlanSchema.shape.priority.options,checklists:native.catalog.checklists.map(item=>({key:item.key,name:item.name}))};
}

export async function inspectNativeServiceOrderTaskPlan(actor:AccountActorContext,tx:TenantTransaction,plan:z.infer<typeof serviceOrderTaskPlanSchema>,boundary:Boundary){
 if(boundary.scope.organizationId!==actor.organizationId||!boundary.scope.propertyId)throw new ServiceOrderAccessError();
 const selected=serviceOrderTaskPlanSchema.parse(plan),rules=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:boundary.scope.propertyId,asOf:boundary.now}),
  metadata=await rules.resolveMetadata({key:"ops.checklists",scopes,asOf:boundary.now}),head=metadata?await rules.sourceMetadataWitness(metadata.id):null;
 if(!head||head.archivedAt)throw new ServiceOrderConfigurationError();
 const checks:CurrentAuthorityCheck[]=[{action:"view",unconditional:true,resource:{...boundary.scope,type:"config_rule",id:head.id,dataClass:"operational",occurredAt:head.createdAt}},{action:"create",resource:{...boundary.scope,type:"task",status:"PLANNED"}}];
 assertAccountAuthorization(actor,boundary.stored,boundary.now,checks,new ServiceOrderAccessError());
 const native=await new OperationRepository(tx,actor.organizationId).checklists(boundary.scope.propertyId),template=native?.catalog.checklists.find(item=>item.key===selected.checklistTemplateKey),after=await rules.sourceMetadataWitness(head.id);
 if(!native||!template)throw new ServiceOrderConfigurationError();if(native.rule.id!==head.id||head.xmin!==after?.xmin||head.tuple!==after.tuple)throw new ServiceOrderConflictError();
 return{ruleId:head.id,ruleVersion:head.version,template,checks,fingerprint:commandFingerprint({selected,head,template})};
}

/** Canonical task creation stays inside the order's transaction and uses its
 * actual reservation, original title/date and independently reviewed plan. */
export async function createNativeServiceOrderTask(actor:AccountActorContext,tx:TenantTransaction,order:Metadata,plan:z.infer<typeof serviceOrderTaskPlanSchema>,reviewedChecklistRuleId:string,boundary:Boundary,command:Command){
 const selected=serviceOrderTaskPlanSchema.parse(plan),native=await nativeServiceCatalogActor(actor,tx),checks:CurrentAuthorityCheck[]=[{action:"create",resource:{...boundary.scope,type:"task",status:"PLANNED"}}];
 assertAccountAuthorization(actor,boundary.stored,boundary.now,checks,new ServiceOrderAccessError());
 try{
  const task=await createOperationTask(native,{...selected,propertyId:order.propertyId,reservationId:order.reservationId,title:localizedTextSchema.parse(order.titleTranslations),dueDate:order.serviceDate.toISOString().slice(0,10),idempotencyKey:command.key,reason:"service.order.confirmation:"+order.id},{db:{$transaction:work=>work(tx)},requestId:command.requestId,ipAddress:null});
  if(task.checklistConfigRuleId!==reviewedChecklistRuleId)throw new ServiceOrderConflictError();
  await recheckAccountAuthorization(actor,tx,await configurationSourceClock(tx,actor.organizationId),checks,new ServiceOrderAccessError());return task;
 }catch(error){nativeTaskError(error);}
}

/** Work cancellation never fabricates a refund or deletes collected funds.
 * Existing native sealed reversals provide the financial clearing evidence. */
export async function cancelNativeServiceOrderTask(actor:AccountActorContext,tx:TenantTransaction,order:Metadata,boundary:Boundary,command:Command){
 if(!order.taskId)return null;const repository=new OperationRepository(tx,actor.organizationId),task=await repository.serviceOrderTaskHead(order.taskId);
 if(!task||task.propertyId!==order.propertyId||task.reservationId!==order.reservationId||task.archivedAt||task.state==="COMPLETED")throw new ServiceOrderSourceUnavailableError();
 const checks:CurrentAuthorityCheck[]=[{action:"view",resource:taskResource(task)},{action:"edit",resource:taskResource(task)},
  {action:"view",organizationOnly:true,unconditional:true,resource:{type:"cash_collection",organizationId:actor.organizationId,dataClass:"financial"}},
  {action:"view",organizationOnly:true,unconditional:true,resource:{type:"financial_transaction",organizationId:actor.organizationId,dataClass:"financial"}}];
 assertAccountAuthorization(actor,boundary.stored,boundary.now,checks,new ServiceOrderAccessError());
 if(await new FinanceRepository(tx,actor.organizationId).serviceOrderActiveCollectionHead(task.id))throw new ServiceOrderSourceUnavailableError();
 const native=await nativeServiceCatalogActor(actor,tx);
 try{
  const result=task.state==="CANCELLED"?task:await transitionOperationTask(native,{taskId:task.id,expectedVersion:task.version,state:"CANCELLED",reason:"service.order.cancellation:"+order.id,idempotencyKey:command.key},{db:{$transaction:work=>work(tx)},requestId:command.requestId,ipAddress:null});
  await recheckAccountAuthorization(actor,tx,await configurationSourceClock(tx,actor.organizationId),checks,new ServiceOrderAccessError());return result;
 }catch(error){nativeTaskError(error);}
}
