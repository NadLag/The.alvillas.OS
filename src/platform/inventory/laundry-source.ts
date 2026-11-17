import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {AuthContext} from "@/platform/authz/authorize";
import {nativeServiceCatalogActor,nativeServiceCatalogProviders,nativeServiceCatalogProviderChoices} from "@/platform/services/catalog-provider-source";
import {ServiceCatalogAccessError,ServiceCatalogConflictError} from "@/modules/services/domain/service-catalog";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
async function native<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){if(error instanceof ServiceCatalogAccessError)throw new InventoryCatalogAccessError();if(error instanceof ServiceCatalogConflictError)throw new InventoryCatalogConflictError();throw error;}}
/** Supplier labels keep their original personal-data grant. No supplier price,
 * invoice, payment or financial posting enters a physical custody review. */
export async function inventoryLaundrySource(actor:AccountActorContext,tx:TenantTransaction,supplierId:string|null,stored:AuthContext,now:Date,allowArchived=false){return native(async()=>{await nativeServiceCatalogActor(actor,tx);return nativeServiceCatalogProviders(actor,tx,supplierId?[{kind:"SUPPLIER",component_key:"laundry_supplier",id:supplierId}]:[],stored,now,{allowArchived});});}
export async function inventoryLaundrySupplierChoices(actor:AccountActorContext,tx:TenantTransaction,input:{query:string;after?:string;includeArchivedSuppliers?:boolean},stored:AuthContext,now:Date){return native(async()=>{await nativeServiceCatalogActor(actor,tx);return nativeServiceCatalogProviderChoices(actor,tx,{...input,kind:"SUPPLIER"},stored,now);});}
