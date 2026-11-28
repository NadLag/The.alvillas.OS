import type {TenantTransaction} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {inventoryPurchaseReceiptKey,inventoryPurchaseSourceKey} from "../domain/purchase-expense";
export class InventoryPurchaseRepository{
 readonly outbox:OutboxRepository;
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){this.outbox=new OutboxRepository(tx,organizationId);}
 runner(){return{$transaction:async<T>(work:(tx:TenantTransaction)=>Promise<T>)=>work(this.tx)};}
 byNonce(nonce:string){return this.outbox.byIdempotencyKey(inventoryPurchaseReceiptKey(nonce));}
 byOriginal(kind:string,rootId:string){return this.outbox.byIdempotencyKey(inventoryPurchaseSourceKey(kind,rootId));}
}
