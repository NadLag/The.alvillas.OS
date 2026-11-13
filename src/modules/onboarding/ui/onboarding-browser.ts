import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";
import {onboardingMaximumCatalogRecordBytes,onboardingMaximumSmallResponseBytes,onboardingMaximumWorkflowRecordBytes,onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
export {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";

export type OnboardingBrowserState="loading"|"ready"|"saved"|"uncertain"|"forbidden"|"offline"|"validation"|"conflict"|"configuration_unavailable"|"rate_limited"|"unavailable";
export type OnboardingEndpoint="options"|"directory"|"owners"|"properties"|"agreements"|"team"|"channels"|"inventory"|"services"|"workflows"|"review"|"admit"|"recover"|"read"|"activation/review"|"activation/admit"|"activation/recover"|"activation/status"|"readiness";
export class OnboardingBrowserError extends Error{constructor(readonly state:OnboardingBrowserState){super(state);}}
export async function onboardingRequest(scope:string,path:OnboardingEndpoint,input:unknown,signal:AbortSignal):Promise<unknown>{
 const mutation=path==="admit"||path==="activation/admit";
 try{
  const response=await fetch("/api/onboarding/"+path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":"application/json","x-alvillas-onboarding-scope":scope},body:JSON.stringify(input)});
  if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new OnboardingBrowserError("forbidden");}
  const record=path==="read"||path==="review",configuration=record&&response.ok&&response.headers.get("content-type")?.includes("application/json")&&response.headers.get("x-alvillas-onboarding-record-step")==="REVIEW",workflow=record&&response.ok&&response.headers.get("content-type")?.includes("application/json")&&response.headers.get("x-alvillas-onboarding-record-step")==="WORKFLOWS",ceiling=configuration?onboardingMaximumConfigurationRecordBytes:workflow?onboardingMaximumWorkflowRecordBytes:record?onboardingMaximumCatalogRecordBytes:onboardingMaximumSmallResponseBytes,bytes=await readBoundedResponseBytes(response,ceiling);let value:unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(configuration&&!z.object({draft:z.object({step:z.literal("REVIEW")})}).safeParse(value).success)throw new OnboardingBrowserError("unavailable");
  if(workflow&&!z.object({draft:z.object({step:z.literal("WORKFLOWS")})}).safeParse(value).success)throw new OnboardingBrowserError("unavailable");
  if(!response.ok){const parsed=z.object({error:z.enum(["validation","conflict","configuration_unavailable","rate_limited"])}).safeParse(value);if(parsed.success)throw new OnboardingBrowserError(parsed.data.error);throw new OnboardingBrowserError(mutation?"uncertain":"unavailable");}
  if(!response.headers.get("content-type")?.includes("application/json"))throw new OnboardingBrowserError(mutation?"uncertain":"unavailable");return value;
 }catch(error){if(error instanceof OnboardingBrowserError)throw error;if(signal.aborted)throw error;throw new OnboardingBrowserError(mutation?"uncertain":"unavailable");}
}
