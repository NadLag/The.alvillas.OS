import type {LeadProfileRevision} from "@prisma/client";
import {decryptLeadProfilePayload,type LeadProfilePayloadBinding} from "../domain/lead-profile-payload";
import {LeadConfigurationError} from "../domain/lead-capture";

export function leadProfileBinding(row:LeadProfileRevision):LeadProfilePayloadBinding{
  if(row.payloadSchemaVersion!==1)throw new LeadConfigurationError();
  return{organizationId:row.organizationId,leadId:row.leadId,revisionId:row.id,previousRevisionId:row.previousId,createdBy:row.createdBy,
    policyId:row.policyId,policyVersion:row.policyVersion,capturePolicyId:row.capturePolicyId,capturePolicyVersion:row.capturePolicyVersion,commandKey:row.commandKey};
}
export function retainedLeadProfile(row:LeadProfileRevision,env?:NodeJS.ProcessEnv){
  const value=decryptLeadProfilePayload(row.encryptedPayload,leadProfileBinding(row),env);
  if(value.sourceKey!==row.sourceKey||value.locale!==row.locale||value.reviewFingerprint!==row.reviewFingerprint)throw new LeadConfigurationError();return value;
}
export function leadProfileReceipt(row:LeadProfileRevision,replayed:boolean){return{id:row.id,leadId:row.leadId,number:row.number,previousRevisionId:row.previousId,sourceKey:row.sourceKey,locale:row.locale,createdAt:row.createdAt.toISOString(),replayed};}
