import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {getExpense,ExpenseAccessError} from "@/modules/finance/application/expense-service";
import {GroceryOrderRepository} from "@/modules/services/infrastructure/grocery-order-repository";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {serviceOrderAuthority} from "@/modules/services/application/service-order-source";
import {ServiceOrderAccessError,ServiceOrderSourceUnavailableError,ServiceOrderConflictError} from "@/modules/services/domain/service-order";
import {groceryPurchaseHistorySchema} from "@/modules/services/domain/grocery-expense";
/** Financial expense families stay canonical; order history only references
 * independently authorized actual expenses and their immutable corrections. */
export async function nativeGroceryPurchaseHistory(actor:AccountActorContext,tx:TenantTransaction,input:{orderId:string;after?:string},requestId:string){
 const orders=new ServiceOrderRepository(tx,actor.organizationId),repository=new GroceryOrderRepository(tx,actor.organizationId);
 async function read(){const head=await orders.head(input.orderId);if(!head)throw new ServiceOrderAccessError();await serviceOrderAuthority(actor,tx,head,"view");if(!(await repository.original(head.id))?.grocery)throw new ServiceOrderSourceUnavailableError();const rows=await repository.purchaseHistory(head.id,input.after),items=[];
  for(const row of rows.slice(0,20)){const expense=await getExpense(actor,row.expenseId,{db:{$transaction:work=>work(tx)}});if(expense.propertyId!==head.propertyId||expense.reservationId&&expense.reservationId!==head.reservationId)throw new ServiceOrderAccessError();items.push({...row,purpose:expense.purpose,amount:expense.amount,currency:expense.currency,state:expense.state,fundingKind:expense.purchase?.fundingKind??null});}
  return{head:{id:head.id,propertyId:head.propertyId,version:head.version},value:groceryPurchaseHistorySchema.parse({orderId:head.id,items,next:rows.length>20?rows[19].expenseId:null})};
 }
 try{const before=await read();await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"service.grocery.purchases_viewed",resourceType:"service_order",resourceId:before.head.id,propertyScopeId:before.head.propertyId,after:{expenseIds:before.value.items.map(row=>row.expenseId)},reason:"Viewed independently authorized original grocery expense families",requestId,occurredAt:await orders.clock()});const after=await read();if(jsonbFingerprint(after)!==jsonbFingerprint(before))throw new ServiceOrderConflictError();return after.value;}catch(error){if(error instanceof ExpenseAccessError)throw new ServiceOrderAccessError();throw error;}
}
