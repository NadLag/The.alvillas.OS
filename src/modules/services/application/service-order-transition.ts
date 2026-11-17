import {Prisma} from "@prisma/client";
import type {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Action} from "@/platform/authz/authorize";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeServiceOrderWork} from "@/platform/services/order-task-source";
import {createNativeServiceOrderTask,cancelNativeServiceOrderTask,inspectNativeServiceOrderTaskPlan} from "@/platform/services/order-task-write";
import {readNativeServiceCatalog,serviceCatalogTermsSources} from "./service-catalog-source";
import {priceServiceOrder,serviceOrderTransitionDraftSchema,serviceOrderTransitionSchema,serviceOrderStateSchema,validateServiceOrderTransition,ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderValidationError,ServiceOrderSourceUnavailableError} from "../domain/service-order";
import {serviceOrderPolicyKey,serviceOrderPolicySchema} from "@/platform/config/service-order-policy";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {inspectOriginalServiceOrder} from "./service-order-original";
import {ServiceOrderRepository} from "../infrastructure/service-order-repository";
import {appendServiceOrderHistory,serviceOrderMetadata} from "./service-order-service";
import {serviceOrderAuthority} from "./service-order-source";
import {validateChefMenuTask,validateChefMenuPerformer} from "../domain/chef-menu";

type Dependencies={db?:TenantTransactionRunner;requestId:string;ipAddress?:string|null};
type Draft=z.infer<typeof serviceOrderTransitionDraftSchema>;
const actions:Partial<Record<Draft["state"],Action>>={QUOTED:"edit",CONFIRMED:"approve",IN_PROGRESS:"edit",FULFILLED:"validate",REJECTED:"reject",CANCELLED:"void"};

async function prepareTransition(actor:AccountActorContext,tx:TenantTransaction,draft:Draft){
 const source=await inspectOriginalServiceOrder(actor,tx,draft.orderId);if(source.root.version!==draft.expectedVersion)throw new ServiceOrderConflictError();
 if(draft.taskPlan)validateChefMenuTask(source.entry,draft.taskPlan.type);
 if(draft.taskPlan&&source.entry.order_terms?.grocery_order&&draft.taskPlan.type!==source.entry.order_terms.grocery_order.task_type)throw new ServiceOrderValidationError();
 if(draft.taskPlan&&source.entry.order_terms?.transfer_order&&draft.taskPlan.type!=="TRANSFER")throw new ServiceOrderValidationError();
 const work=await nativeServiceOrderWork(actor,tx,source.root,source.authority.stored,source.authority.now),total=validateServiceOrderTransition({from:serviceOrderStateSchema.parse(source.root.state),to:draft.state,pricingModel:source.entry.pricing_model,total:source.total,quote:draft.quote,currency:source.root.currency,currencyPrecision:source.currency.minorUnit,hasActualTaskStart:work.started,hasActualTaskCompletion:work.completed}),
  action=actions[draft.state];if(!action)throw new ServiceOrderConflictError();const actionCheck=source.actionCheck(action,total?.toJSON().amount);
 assertAccountAuthorization(actor,source.authority.stored,source.authority.now,[...source.checks,...work.checks,actionCheck],new ServiceOrderAccessError());
 if(draft.state==="FULFILLED")validateChefMenuPerformer(source.entry,work.performedPersonId);
 let currentCatalogFingerprint:string|null=null,recheckCurrentSources:(()=>Promise<void>)|null=null;const currentChecks:CurrentAuthorityCheck[]=[];
 if(draft.state==="QUOTED"||draft.state==="CONFIRMED"){
  const current=await readNativeServiceCatalog(actor,tx,{propertyId:source.root.propertyId,source:source.authority.reservation.source});
  if(current.rule?.id!==source.root.catalogRuleId||source.authority.property.archivedAt||source.authority.reservation.archivedAt)throw new ServiceOrderSourceUnavailableError();
  const entry=current.catalog?.services.find(item=>item.key===source.root.serviceKey);if(!entry)throw new ServiceOrderSourceUnavailableError();
  const rules=new ConfigRuleRepository(tx,actor.organizationId),metadata=await rules.resolveMetadata({key:serviceOrderPolicyKey,scopes:current.scopes,asOf:source.authority.now}),policy=metadata?await rules.sourceMetadataWitness(metadata.id):null;if(!policy)throw new ServiceOrderSourceUnavailableError();
  const policyChecks:CurrentAuthorityCheck[]=(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...source.authority.scope,type:"config_rule",id:policy.id,dataClass:"operational",occurredAt:policy.createdAt}}));
  assertAccountAuthorization(actor,source.authority.stored,source.authority.now,policyChecks,new ServiceOrderAccessError());
  const value=await rules.sourceWitness(policy.id);if(!value||value.xmin!==policy.xmin||value.tuple!==policy.tuple)throw new ServiceOrderConflictError();
  priceServiceOrder(source.request,entry,source.authority.reservation,source.authority.property,serviceOrderPolicySchema.parse(value.value));
  const terms=await serviceCatalogTermsSources(actor,tx,current,[entry],true);currentCatalogFingerprint=jsonbFingerprint({rule:current.witness,policy,terms:terms.fingerprint});currentChecks.push(...current.checks,...policyChecks,...terms.checks);
  recheckCurrentSources=async()=>{
   const latest=await readNativeServiceCatalog(actor,tx,{propertyId:source.root.propertyId,source:source.authority.reservation.source}),metadata=await rules.resolveMetadata({key:serviceOrderPolicyKey,scopes:latest.scopes,asOf:latest.now}),head=metadata?await rules.sourceMetadataWitness(metadata.id):null,
    latestTerms=await serviceCatalogTermsSources(actor,tx,latest,[entry],true);
   if(jsonbFingerprint({rule:latest.witness,policy:head,terms:latestTerms.fingerprint})!==currentCatalogFingerprint)throw new ServiceOrderConflictError();
  };
 }
 const taskPlan=draft.taskPlan?await inspectNativeServiceOrderTaskPlan(actor,tx,draft.taskPlan,source.authority):null,
  reviewFingerprint=jsonbFingerprint({draft,head:serviceOrderMetadata(source.head),total:source.total?.toJSON()??null,quoteReference:source.root.quoteReference,source:source.sourceFingerprint,work:work.fingerprint,currentCatalogFingerprint,taskPlan:taskPlan?.fingerprint??null});
 return{source,work,total,taskPlan,actionCheck,currentChecks,recheckCurrentSources,reviewFingerprint};
}

export async function previewServiceOrderTransition(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const draft=serviceOrderTransitionDraftSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const prepared=await prepareTransition(actor,tx,draft);await prepared.source.recheck([...prepared.work.checks,prepared.actionCheck,...prepared.currentChecks,...(prepared.taskPlan?.checks??[])]);await prepared.recheckCurrentSources?.();
  return{reviewFingerprint:prepared.reviewFingerprint,order:serviceOrderMetadata(prepared.source.head),targetState:draft.state,totalAmount:prepared.total?.toJSON().amount??null,currency:prepared.source.root.currency,
   quoteReference:draft.quote?.approvalReference??prepared.source.root.quoteReference,taskPlan:prepared.taskPlan?{ruleId:prepared.taskPlan.ruleId,ruleVersion:prepared.taskPlan.ruleVersion,...draft.taskPlan,template:prepared.taskPlan.template}:null};
 },{timeout:120000});
}

/** Native task writes and the order history share one transaction. State
 * acceptance never invents a financial transaction or actual completed work. */
export async function transitionServiceOrder(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const command=serviceOrderTransitionSchema.parse(raw),hash=jsonbFingerprint({operation:"TRANSITION",command});
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId);await repository.lockCommand(command.idempotencyKey);await repository.lockOrder(command.orderId);
  const recorded=await repository.byNonce(command.idempotencyKey);
  if(recorded){
   if(recorded.orderId!==command.orderId||recorded.commandHash!==hash||recorded.createdBy!==actor.actorId)throw new ServiceOrderConflictError();
   const original=await inspectOriginalServiceOrder(actor,tx,recorded.orderId);await original.recheck();return{orderId:recorded.orderId,eventId:recorded.id,version:recorded.version,state:recorded.toState,replayed:true};
  }
  const {idempotencyKey,reviewFingerprint,...rawDraft}=command,draft=serviceOrderTransitionDraftSchema.parse(rawDraft),prepared=await prepareTransition(actor,tx,draft),{source}=prepared;
  if(prepared.reviewFingerprint!==reviewFingerprint)throw new ServiceOrderConflictError();
  let taskId=source.root.taskId;
  if(draft.state==="CONFIRMED"){
   if(taskId||!draft.taskPlan||!prepared.taskPlan)throw new ServiceOrderConflictError();const task=await createNativeServiceOrderTask(actor,tx,source.root,draft.taskPlan,prepared.taskPlan.ruleId,source.authority,{key:idempotencyKey,requestId:deps.requestId});taskId=task.id;
  }else if(draft.state==="CANCELLED")await cancelNativeServiceOrderTask(actor,tx,source.root,source.authority,{key:idempotencyKey,requestId:deps.requestId});
  if(!await repository.change(source.root.id,draft.expectedVersion,{state:draft.state,version:draft.expectedVersion+1,taskId,totalAmount:prepared.total?new Prisma.Decimal(prepared.total.toJSON().amount):null,
   quoteReference:draft.state==="QUOTED"?draft.quote!.approvalReference:source.root.quoteReference,updatedAt:await repository.clock()}))throw new ServiceOrderConflictError();
  const order=await repository.original(source.root.id);if(!order)throw new ServiceOrderConflictError();
  const result=await appendServiceOrderHistory(actor,tx,order,{fromState:source.root.state,commandKey:idempotencyKey,commandHash:hash,reviewFingerprint,reason:draft.reason},deps);
  await source.recheck([...prepared.work.checks,prepared.actionCheck,...prepared.currentChecks,...(prepared.taskPlan?.checks??[])]);await prepared.recheckCurrentSources?.();
  if(draft.taskPlan&&prepared.taskPlan){const current=await serviceOrderAuthority(actor,tx,source.head),after=await inspectNativeServiceOrderTaskPlan(actor,tx,draft.taskPlan,current);if(after.fingerprint!==prepared.taskPlan.fingerprint)throw new ServiceOrderConflictError();}
  if(draft.state!=="CONFIRMED"&&draft.state!=="CANCELLED"){
   const work=await nativeServiceOrderWork(actor,tx,source.root,source.authority.stored,await repository.clock());if(work.fingerprint!==prepared.work.fingerprint)throw new ServiceOrderConflictError();
  }
  await repository.validateAtomicHistory();return{...result,replayed:false};
 },{timeout:120000});
}
