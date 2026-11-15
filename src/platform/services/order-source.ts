import type {TenantTransaction} from "@/platform/db/tenant";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {ReservationRepository} from "@/modules/reservations/infrastructure/reservation-repository";

/** Only native value-free property and reservation metadata crosses modules.
 * The application authorizes these identities before reading private originals. */
export const nativeServiceOrderProperty=async(tx:TenantTransaction,organizationId:string,id:string)=>(await new CoreRepository(tx,organizationId).onboardingPropertyHeads([id],true))[0]??null;
export const nativeServiceOrderReservation=(tx:TenantTransaction,organizationId:string,id:string)=>new ReservationRepository(tx,organizationId).serviceOrderSourceHead(id);
