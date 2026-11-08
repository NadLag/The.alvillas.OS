import {z} from "zod";
import type {LocalizedText} from "@/i18n/content";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {LeadRepository} from "@/modules/crm/infrastructure/lead-repository";
import {LeadWorkspaceRepository} from "@/modules/crm/infrastructure/lead-workspace-repository";
import {leadResource} from "@/modules/crm/application/lead-resource";
import {leadCaptureBinding} from "@/modules/crm/application/lead-capture-service";
import {retainedLeadProfile} from "@/modules/crm/application/lead-profile-snapshot";
import {decryptLeadPayload} from "@/modules/crm/domain/lead-payload";
import {leadCapturePolicyKey,leadCapturePolicySchema} from "@/modules/crm/domain/lead-capture";
import {TemplateBindingError,type DocumentTemplateBinding,type DocumentTemplateDefinition} from "@/modules/documents/domain/document-template";

type LeadRow=Awaited<ReturnType<LeadWorkspaceRepository["rows"]>>[number];
function retainedNativeSource(lead:LeadRow,current:{id:string;version:number;value:unknown}){
 const profile=lead.profileRevisions[0],stage={stage:lead.stageRevisions[0]?.toStage??lead.initialStage,revisionId:lead.stageRevisions[0]?.id??null},assignment=lead.workEntries[0];
 const retained=z.object({value:leadCapturePolicySchema}).passthrough().safeParse(profile?.capturePolicySnapshot??lead.policySnapshot);if(!retained.success)return null;
 const snapshot={leadId:lead.id,payloadSha256:lead.payloadSha256,profileRevisionId:profile?.id??null,profilePayloadSha256:profile?.payloadSha256??null,stageRevisionId:stage.revisionId,stage:stage.stage,
  assignmentRevisionId:assignment?.id??null,representativeId:assignment?.representativeId??null,representativePersonId:assignment?.representativePersonId??null,
  capturePolicyId:current.id,capturePolicyVersion:current.version,capturePolicyFingerprint:commandFingerprint(current.value)};
 return{lead,profile,retainedPolicy:retained.data.value,resource:leadResource(lead,stage.stage,assignment),snapshot,label:lead.id,archived:false};
}

/** Reuse the native workspace's bounded source batch; authorization remains at the document boundary. */
export async function nativeLeadDocumentSources(tx:TenantTransaction,organizationId:string,leadIds:readonly string[]){
 const ids=[...new Set(leadIds)];if(ids.length>100)throw new TemplateBindingError();
 const empty=()=>new Map<string,ReturnType<typeof retainedNativeSource>>(ids.map(id=>[id,null]));if(!ids.length)return empty();
 const rows=await new LeadWorkspaceRepository(tx,organizationId).rows(ids),now=await new LeadRepository(tx,organizationId).clock(),current=await new ConfigRuleRepository(tx,organizationId).resolve({key:leadCapturePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
 if(!current?.createdBy||!leadCapturePolicySchema.safeParse(current.parsedValue).success)return empty();
 const found=new Map(rows.map(lead=>[lead.id,retainedNativeSource(lead,current)]));return new Map(ids.map(id=>[id,found.get(id.toLowerCase())??null]));
}
export async function nativeLeadDocumentSource(tx:TenantTransaction,organizationId:string,leadId:string){return(await nativeLeadDocumentSources(tx,organizationId,[leadId])).get(leadId)??null;}

/** Fixed approved fields; private notes, referral identities and financial values are not bindings. */
export async function nativeLeadDocumentBindings(tx:TenantTransaction,organizationId:string,leadId:string,requested:readonly string[],locale:DocumentTemplateDefinition["locale"],env?:NodeJS.ProcessEnv){
 if(requested.length>200||new Set(requested).size!==requested.length)throw new TemplateBindingError();
 const native=await nativeLeadDocumentSource(tx,organizationId,leadId);if(!native)throw new TemplateBindingError();
 const payload=native.profile?retainedLeadProfile(native.profile,env):decryptLeadPayload(native.lead.encryptedPayload,leadCaptureBinding(native.lead),env),fields=payload.fields,values=new Map<string,DocumentTemplateBinding>();
 const text=(key:string,value:string|undefined)=>{if(value!==undefined&&value.length)values.set(key,{kind:"TEXT",value,privacy:["sensitive"]});};
 const integer=(key:string,value:number|undefined)=>{if(value!==undefined){if(!Number.isSafeInteger(value))throw new TemplateBindingError();values.set(key,{kind:"INTEGER",value:String(value),privacy:["sensitive"]});}};
 const catalog=(key:string|undefined,rows:readonly{key:string;label:LocalizedText}[])=>key===undefined?undefined:rows.find(row=>row.key===key)?.label[locale];
 text("source_label",native.label);text("lead_owner_contact",fields.ownerContact);text("lead_phone",fields.phone);text("lead_email",fields.email);text("lead_location",fields.location);text("lead_objectives",fields.objectives);
 text("lead_property_type",catalog(fields.propertyTypeKey,native.retainedPolicy.property_types));text("lead_rental_status",catalog(fields.currentRentalStatusKey,native.retainedPolicy.rental_statuses));
 text("lead_acquisition_source",catalog(payload.sourceKey,native.retainedPolicy.sources));integer("lead_bedrooms",fields.bedrooms);
 if(fields.currentOtaKeys!==undefined){integer("lead_current_ota_count",fields.currentOtaKeys.length);const labels=fields.currentOtaKeys.map(key=>catalog(key,native.retainedPolicy.otas));if(labels.every((value):value is string=>value!==undefined))text("lead_current_otas",labels.join("\n"));}
 values.set("lead_capture_date",{kind:"DATE",value:native.lead.createdAt.toISOString().slice(0,10),privacy:["sensitive"]});
 const bindings=new Map<string,DocumentTemplateBinding>();for(const key of requested){const value=values.get(key);if(!value)throw new TemplateBindingError();bindings.set(key,value);}
 return{bindings:bindings as ReadonlyMap<string,DocumentTemplateBinding>,fingerprint:commandFingerprint({source:native.snapshot,locale,values:[...bindings].sort(([left],[right])=>left.localeCompare(right))})};
}
