import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {maskedNativeOnboardingChannelEndpoint} from "@/platform/onboarding/contracts";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingOwnerSchema,OnboardingConfigurationError,onboardingMaximumRequestBytes} from "./onboarding-wizard";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";
import {canonicalOnboardingBookingChannelsCommand,onboardingBookingChannelsSnapshotSchema,presentOnboardingBookingChannelsDraft,type OnboardingBookingChannelsCommand} from "./onboarding-booking-channels";

const bindingSchema=onboardingPayloadBindingSchema.extend({propertyId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export type OnboardingBookingChannelsPayloadBinding=z.infer<typeof bindingSchema>;
export const onboardingMaximumBookingChannelsPayloadBytes=onboardingMaximumRequestBytes*3;
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema,originalProperty:onboardingPropertySnapshotSchema,previousChannels:onboardingBookingChannelsSnapshotSchema,originalChannels:onboardingBookingChannelsSnapshotSchema}).strict();
type Input=Omit<z.infer<typeof payloadSchema>,"command">&{command:OnboardingBookingChannelsCommand};
function context(raw:OnboardingBookingChannelsPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-booking-channels-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingBookingChannelsPayloadBinding){
 const value=payloadSchema.parse(raw),command=canonicalOnboardingBookingChannelsCommand(value.command),b=bindingSchema.parse(binding),target=command.target,previous=value.previousChannels,original=value.originalChannels;
 if(command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||target.propertyId!==b.propertyId||value.originalProperty.id!==b.propertyId||!["DRAFT","ONBOARDING"].includes(value.originalProperty.status)||previous.propertyId!==b.propertyId||original.propertyId!==b.propertyId)throw new OnboardingConfigurationError();
 if(target.mode==="LINK"){if(commandFingerprint(previous)!==commandFingerprint(original)||original.channels.length!==target.channelIds.length||original.channels.some(row=>!target.channelIds.includes(row.id)))throw new OnboardingConfigurationError();}
 else{
  if(original.channels.length!==target.channels.length||previous.channels.some(row=>!target.channels.some(input=>input.sourceKey===row.sourceKey)))throw new OnboardingConfigurationError();
  for(const input of target.channels){const row=original.channels.find(row=>row.sourceKey===input.sourceKey),before=previous.channels.find(row=>row.sourceKey===input.sourceKey);if(!row||row.archivedAt!==null||!isDeepStrictEqual({sourceKey:row.sourceKey,displayName:row.displayName,externalListingId:row.externalListingId,listingUrl:row.listingUrl,syncMode:row.syncMode,importEnabled:row.importEnabled,exportEnabled:row.exportEnabled,status:row.status},{sourceKey:input.sourceKey,displayName:input.displayName,externalListingId:input.externalListingId,listingUrl:input.listingUrl,syncMode:input.syncMode,importEnabled:input.importEnabled,exportEnabled:input.exportEnabled,status:input.status})||before&&(row.id!==before.id||row.createdBy!==before.createdBy||row.createdAt!==before.createdAt)||!before&&row.createdBy!==b.createdBy)throw new OnboardingConfigurationError();
   if(input.syncEndpointUrl!==null){if(!row.hasSyncEndpoint||row.maskedSyncEndpoint!==maskedNativeOnboardingChannelEndpoint(input.syncEndpointUrl))throw new OnboardingConfigurationError();}else if(row.hasSyncEndpoint!==(before?.hasSyncEndpoint??false)||row.maskedSyncEndpoint!==(before?.maskedSyncEndpoint??null))throw new OnboardingConfigurationError();
  }
 }
 return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,previousChannels:previous,originalChannels:original};
}
export function encryptOnboardingBookingChannelsPayload(raw:Input,binding:OnboardingBookingChannelsPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const value=bound(raw,binding),bytes=Buffer.from(JSON.stringify(value),"utf8");try{if(bytes.length>onboardingMaximumBookingChannelsPayloadBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(bytes,context(binding),env);if(cipher.byteLength>onboardingMaximumBookingChannelsPayloadBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{bytes.fill(0);}}
export function decryptOnboardingBookingChannelsPayload(cipher:Uint8Array,binding:OnboardingBookingChannelsPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumBookingChannelsPayloadBytes)throw new OnboardingConfigurationError();const bytes=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(bytes.toString("utf8")),binding);}finally{bytes.fill(0);}}

/** Original submitted credentials remain encrypted history, never a private read/recovery response. */
export function presentOnboardingBookingChannelsPayload(value:ReturnType<typeof decryptOnboardingBookingChannelsPayload>){
 const {sessionId,previousRevisionId,step,target}=value.command,safe=presentOnboardingBookingChannelsDraft({sessionId,previousRevisionId,step,target});
 return{...value,command:{...value.command,target:safe.target}};
}
