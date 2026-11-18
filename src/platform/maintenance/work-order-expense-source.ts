import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {getExpense,ExpenseAccessError} from "@/modules/finance/application/expense-service";
import {workOrderExpenseSourceSchema} from "@/modules/maintenance/domain/work-order-finance";
import {WorkOrderAccessError,WorkOrderConflictError,workOrderRegistrationReceiptSchema} from "@/modules/maintenance/domain/work-order";
import {WorkOrderRepository} from "@/modules/maintenance/infrastructure/work-order-repository";
import {nativeMaintenanceWorkOrderTask} from "./work-order-source";

export async function readWorkOrderExpense(actor: AccountActorContext, tx: TenantTransaction,
  input: { expenseId: string; propertyId: string; reservationId: string | null }) {
  let shown;
  try {
    shown = await getExpense(actor, input.expenseId, { db: { $transaction: async work => work(tx) } });
  } catch (error) {
    if (error instanceof ExpenseAccessError) throw new WorkOrderAccessError();
    throw error;
  }
  if (shown.propertyId !== input.propertyId || shown.reservationId && shown.reservationId !== input.reservationId)
    throw new WorkOrderAccessError();
  return workOrderExpenseSourceSchema.parse({
    id: shown.id, version: shown.version, propertyId: shown.propertyId, reservationId: shown.reservationId,
    state: shown.state, purpose: shown.purpose, category: shown.category, occurredOn: shown.occurredOn,
    money: Money.of(shown.amount, shown.currency).toJSON(), approvalId: shown.approvalId,
    canEdit: shown.canEditDraft, canSubmit: shown.canSubmit
  });
}

/** Consume the native financial service's presented facts. Operational task
 * access never substitutes for original expense, owner or wallet authority. */
export async function inspectWorkOrderExpense(actor:AccountActorContext,tx:TenantTransaction,input:{taskId:string;expenseId:string}){
 const repository=new WorkOrderRepository(tx,actor.organizationId),original=await repository.original(input.taskId);if(!original)throw new WorkOrderAccessError();
 const registration=workOrderRegistrationReceiptSchema.parse(original),task=await nativeMaintenanceWorkOrderTask(actor,tx,input.taskId);
 if(registration.taskId!==input.taskId||registration.organizationId!==actor.organizationId||registration.propertyId!==task.task.propertyId)throw new WorkOrderAccessError();
 const read = () => readWorkOrderExpense(actor, tx, {
  expenseId: input.expenseId, propertyId: task.task.propertyId, reservationId: task.task.reservationId
 });
 const expense=await read(),fingerprint=jsonbFingerprint({registration,task:task.fingerprint,expense});
 return{expense,fingerprint,recheck:async()=>{const current=await read();await task.recheck();if(fingerprint!==jsonbFingerprint({registration:await repository.original(input.taskId),task:task.fingerprint,expense:current}))throw new WorkOrderConflictError();}};
}
