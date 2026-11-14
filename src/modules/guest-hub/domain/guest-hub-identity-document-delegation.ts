import {z} from "zod";
import {authorizationCapSchema} from "@/platform/authz/authorization-cap";
import {signBytes,verifyBytes} from "@/platform/auth/secret-encryption";
import {documentArchivePolicySchema,documentRetentionPolicySchema} from "@/modules/documents";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {GuestHubIdentityDocumentConfigurationError} from "./guest-hub-identity-document-policy";

const rule={organizationId:guestHubIdSchema,id:guestHubIdSchema,version:z.number().int().positive().max(2147483647)};
export const guestHubIdentityDocumentDelegationBindingSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_IDENTITY_DOCUMENT_DELEGATION_V1"),
 organizationId:guestHubIdSchema,grantId:guestHubIdSchema,grantFingerprint:guestHubFingerprintSchema,createdBy:guestHubIdSchema,
 authorizationCap:authorizationCapSchema,
 archivePolicy:z.object({...rule,value:documentArchivePolicySchema}).strict(),
 retentionPolicy:z.object({...rule,value:documentRetentionPolicySchema}).strict()
}).strict().superRefine((value,context)=>{
 if(value.authorizationCap.organizationId!==value.organizationId||value.authorizationCap.userAccountId!==value.createdBy||value.archivePolicy.organizationId!==value.organizationId||value.retentionPolicy.organizationId!==value.organizationId)context.addIssue({code:"custom",message:"actual_identity_delegation_tenant_and_creator_required"});
});
export type GuestHubIdentityDocumentDelegationBinding=z.infer<typeof guestHubIdentityDocumentDelegationBindingSchema>;
const purpose="alvillas.guest-hub.identity-document-delegation.v1";

/** A separate purpose binds the original document authority without changing retained form-grant bytes. */
export function signGuestHubIdentityDocumentDelegation(raw:unknown,env:NodeJS.ProcessEnv=process.env){
 let plain:Buffer|undefined;
 try{plain=Buffer.from(JSON.stringify(guestHubIdentityDocumentDelegationBindingSchema.parse(raw)));return signBytes(plain,purpose,env);}catch{throw new GuestHubIdentityDocumentConfigurationError();}finally{plain?.fill(0);}
}
export function verifyGuestHubIdentityDocumentDelegation(raw:unknown,version:string,signature:Uint8Array,env:NodeJS.ProcessEnv=process.env){
 let plain:Buffer|undefined;
 try{plain=Buffer.from(JSON.stringify(guestHubIdentityDocumentDelegationBindingSchema.parse(raw)));return verifyBytes(plain,signature,version,purpose,env);}catch{return false;}finally{plain?.fill(0);}
}
