import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import type {GuestHubAgreementOriginal} from "../domain/guest-hub-agreement-source";
import type {guestHubAgreementTemplate} from "../domain/guest-hub-agreement-policy";
import type {GuestHubAgreementNativeStatus} from "../domain/guest-hub-agreement-progress";

export type GuestHubAgreementPreparedAuthority={
 original:GuestHubAgreementOriginal;preparationId:string;fingerprint:string;documentVersionNumber:number;
 archivePolicyId:string;signaturePolicyId:string;templatePolicyId:string;
};
/** App composition supplies the existing native original PDF, template, guest
 * recipient, prepared provider identity and independent source/signature grants. */
export interface GuestHubAgreementDocumentAuthorityProvider{
 capture(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,selection:ReturnType<typeof guestHubAgreementTemplate>,preparationId:string,env?:NodeJS.ProcessEnv):Promise<GuestHubAgreementPreparedAuthority>;
 status(actor:AccountActorContext,tx:TenantTransaction,original:GuestHubAgreementOriginal,preparationId:string,env?:NodeJS.ProcessEnv):Promise<GuestHubAgreementNativeStatus>;
 choices(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,selection:ReturnType<typeof guestHubAgreementTemplate>,filter:string,cursor?:string,env?:NodeJS.ProcessEnv):Promise<{items:Array<{preparationId:string;preparedAt:string;original:GuestHubAgreementOriginal;documentVersionNumber:number}>;next:string|null}>;
 history(actor:AccountActorContext,tx:TenantTransaction,original:GuestHubAgreementOriginal,env?:NodeJS.ProcessEnv):Promise<{documentVersionNumber:number}>;
}
