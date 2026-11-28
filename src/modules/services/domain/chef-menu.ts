import type {ServiceCatalogEntry} from "./service-catalog";
import {ServiceOrderValidationError,ServiceOrderSourceUnavailableError} from "./service-order";

/** Menu authoring selects a real PERSON component from the existing immutable
 * financial recipe. A cooking task never establishes that person did the work. */
export function validateChefMenuTask(entry:ServiceCatalogEntry,type:string){
 if(entry.order_terms?.chef_menu&&type!=="CHEF")throw new ServiceOrderValidationError();
}
export function validateChefMenuPerformer(entry:ServiceCatalogEntry,performedPersonId:string|null){
 const menu=entry.order_terms?.chef_menu;if(!menu)return;
 const chef=entry.order_terms!.providers.find(provider=>provider.component_key===menu.chef_component_key&&provider.kind==="PERSON");
 if(!chef||!performedPersonId||chef.id!==performedPersonId)throw new ServiceOrderSourceUnavailableError();
}
